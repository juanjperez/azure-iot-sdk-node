import * as machina from 'machina';
import * as amqp10 from 'amqp10';
import * as dbg from 'debug';
import { EventEmitter } from 'events';
import { Message, results, errors } from 'azure-iot-common';
import { AmqpMessage } from './amqp_message';
import { AmqpTransportError } from './amqp_common_errors';
import { AmqpLink } from './amqp_link_interface';

const debug = dbg('AmqpReceiverLinkFsm');

export class AmqpReceiverLinkFsm  extends EventEmitter implements AmqpLink {
  private _linkAddress: string;
  private _linkOptions: string;
  private _linkObject: any;
  private _fsm: machina.Fsm;
  private _amqp10Client: amqp10.AmqpClient;
  private _attachCallback: (err?: Error) => void;
  private _detachHandler: (detachEvent: any) => void;
  private _messageHandler: (message: AmqpMessage) => void;
  private _errorHandler: (err: Error) => void;

  constructor(linkAddress: string, linkOptions: any, amqp10Client: amqp10.AmqpClient) {
    super();
    this._linkAddress = linkAddress;
    this._linkOptions = linkOptions;
    this._amqp10Client = amqp10Client;

    this._detachHandler = (detachEvent: any): void => {
      this._linkObject = null;
      if (detachEvent.error) {
        this.emit('error', detachEvent.error);
      }
      this._fsm.transition('detached');
    };

    this._messageHandler = (message: AmqpMessage): void => {
      this.emit('message', AmqpMessage.toMessage(message));
    };

    this._errorHandler = (err: Error): void => {
      this.emit('errorReceived', err);
    };


    this._fsm = new machina.Fsm({
      initialState: 'detached',
      states: {
        detached: {
          attach: (callback) => {
            this._attachCallback = callback;
            this._fsm.transition('attaching');
          },
          detach: (callback) => callback(),
          '*': () => this._fsm.deferUntilTransition('attached')
        },
        attaching: {
          _onEnter: () => {
            this._attachLink((err) => {
              let newState = err ? 'detached' : 'attached';
              this._fsm.transition(newState);
              if (this._attachCallback) {
                let cb = this._attachCallback;
                this._attachCallback = null;
                cb(err);
              }
            });
          },
          detach: () => {
            this._fsm.transition('detaching');
            this._detachLink();
            this._fsm.transition('detached');
          },
          '*': () => this._fsm.deferUntilTransition('attached')
        },
        attached: {
          _onEnter: () => {
            this._linkObject.on('detached', this._detachHandler);
            this._linkObject.on('message', this._messageHandler);
            this._linkObject.on('errorReceived', this._errorHandler);
          },
          _onExit: () => {
            this._linkObject.removeListener('detached', this._detachHandler);
            this._linkObject.removeListener('message', this._messageHandler);
            this._linkObject.removeListener('errorReceived', this._errorHandler);
          },
          attach: (callback) => callback(),
          detach: () => {
            this._fsm.transition('detaching');
            this._detachLink();
            this._fsm.transition('detached');
          },
          accept: (message, callback) => {
            this._linkObject.accept(message);
            if (callback) callback(null, new results.MessageCompleted());
          },
          reject: (message, callback) => {
            this._linkObject.reject(message);
            if (callback) callback(null, new results.MessageRejected());
          },
          abandon: (message, callback) => {
            this._linkObject.abandon(message);
            if (callback) callback(null, new results.MessageAbandoned());
          }
        },
        detaching: {
          '*': () => this._fsm.deferUntilTransition('detached')
        }
      }
    });

    this.on('removeListener', () => {
      // stop listening for AMQP events if our consumers stop listening for our events
      if (this.listeners('message').length === 0) {
        this._fsm.handle('detach');
      }
    });

    this.on('newListener', (eventName) => {
      // lazy-init AMQP event listeners
      if (eventName === 'message') {
        this._fsm.handle('attach', (err) => {
          if (err) {
            // TODO clean up between errorReceived and error events.
            this.emit('error', err);
          }
        });
      }
    });
  }

  detach(): void {
    this._fsm.handle('detach');
  }

  attach(callback: (err?: Error) => void): void {
    this._fsm.handle('attach', callback);
  }

  accept(message: Message, callback?: (err?: Error, result?: results.MessageCompleted) => void): void {
    if (!message) { throw new ReferenceError('Invalid message object.'); }
    this._fsm.handle('accept', message.transportObj, callback);
  }

  complete(message: Message, callback?: (err?: Error, result?: results.MessageCompleted) => void): void {
    this.accept(message, callback);
  }

  reject(message: Message, callback?: (err?: Error, result?: results.MessageRejected) => void): void {
    if (!message) { throw new ReferenceError('Invalid message object.'); }
    this._fsm.handle('reject', message, callback);
  }

  abandon(message: Message, callback?: (err?: Error, result?: results.MessageAbandoned) => void): void {
    if (!message) { throw new ReferenceError('Invalid message object.'); }
    this._fsm.handle('abandon', message, callback);
  }

  private _attachLink(done: (err?: Error) => void): void {
    /*Codes_SRS_NODE_COMMON_AMQP_16_033: [The `attachReceiverLink` method shall call the `done` callback with a `NotConnectedError` object if the amqp client is not connected when the method is called.]*/
    let connectionError = null;
    let clientErrorHandler = (err) => {
      connectionError = err;
    };
    /*Codes_SRS_NODE_COMMON_AMQP_16_007: [If send encounters an error before it can send the request, it shall invoke the `done` callback function and pass the standard JavaScript Error object with a text description of the error (err.message).]*/
    this._amqp10Client.on('client:errorReceived', clientErrorHandler);

    /*Codes_SRS_NODE_COMMON_AMQP_06_004: [The `attachReceiverLink` method shall create a policy object that contain link options to be merged if the linkOptions argument is not falsy.]*/
    /*Codes_SRS_NODE_COMMON_AMQP_16_018: [The `attachReceiverLink` method shall call `createReceiver` on the `amqp10` client object.]*/
    this._amqp10Client.createReceiver(this._linkAddress, this._linkOptions)
      .then((receiver) => {
        receiver.on('detached', (detached) => {
          debug('receiver link detached: ' + this._linkAddress);
        });
        this._amqp10Client.removeListener('client:errorReceived', clientErrorHandler);
        if (!connectionError) {
          debug('AmqpReceiver object created for endpoint: ' + this._linkAddress);
          this._linkObject = receiver;
          /*Codes_SRS_NODE_COMMON_AMQP_16_020: [The `attachReceiverLink` method shall call the `done` callback with a `null` error and the link object that was created if the link was attached successfully.]*/
          this._safeCallback(done);
        } else {
          /*Codes_SRS_NODE_COMMON_AMQP_16_021: [The `attachReceiverLink` method shall call the `done` callback with an `Error` object if the link object wasn't created successfully.]*/
          this._safeCallback(done, connectionError);
        }

        return null;
      })
      .catch((err) => {
        let error: AmqpTransportError = new errors.NotConnectedError('AMQP: Could not create receiver');
        error.amqpError = err;
        /*Codes_SRS_NODE_COMMON_AMQP_16_021: [The `attachReceiverLink` method shall call the `done` callback with an `Error` object if the link object wasn't created successfully.]*/
        this._safeCallback(done, error);
      });
  }

  private _detachLink(): void {
    this._linkObject.forceDetach();
    this._linkObject = null;
  }

  /*Codes_SRS_NODE_COMMON_AMQP_16_011: [All methods should treat the `done` callback argument as optional and not throw if it is not passed as argument.]*/
  private _safeCallback(callback: (err?: Error, result?: any) => void, error?: Error | null, result?: any): void {
    if (callback) {
      process.nextTick(() => callback(error, result));
    }
  }
}
