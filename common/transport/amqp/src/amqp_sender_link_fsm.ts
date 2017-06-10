import * as machina from 'machina';
import * as amqp10 from 'amqp10';
import * as dbg from 'debug';
import { EventEmitter } from 'events';
import { Message, results, errors } from 'azure-iot-common';
import { AmqpMessage } from './amqp_message';
import { AmqpLink } from './amqp_link_interface';
import { AmqpTransportError } from './amqp_common_errors';

const debug = dbg('AmqpSenderLinkFsm');

export type SendCallback = (err?: Error, result?: results.MessageEnqueued) => void;

export class AmqpSenderLinkFsm extends EventEmitter implements AmqpLink {
  private _linkAddress: string;
  private _linkOptions: any;
  private _linkObject: any;
  private _fsm: machina.Fsm;
  private _amqp10Client: amqp10.AmqpClient;
  private _messageQueue: {
    message: Message,
    to: string,
    callback: SendCallback
  }[];
  private _attachCallback: (err?: Error) => void;

  constructor(linkAddress: string, linkOptions: any, amqp10Client: amqp10.AmqpClient) {
    super();
    this._linkAddress = linkAddress;
    this._linkOptions = linkOptions;
    this._amqp10Client = amqp10Client;
    this._messageQueue = [];
    this._fsm = new machina.Fsm({
      initialState: 'detached',
      states: {
        detached: {
          attach: (callback) => {
            this._attachCallback = callback;
            this._fsm.transition('attaching');
            this._attachLink(this._linkAddress, this._linkOptions, (err) => {
              let newState = err ? 'detaching' : 'attached';
              this._fsm.transition(newState);

              if (callback) {
                callback(err);
              }
            });
          },
          detach: (callback) => {
            if (callback) callback();
          },
          send: (message, to, callback) => {
            this._messageQueue.push({
              message: message,
              to: to,
              callback: callback
            });
            this._fsm.handle('attach', (err) => {
              if (err) {
                let toSend = this._messageQueue.shift();
                while (toSend) {
                  toSend.callback(err);
                  toSend = this._messageQueue.shift();
                }
              }
            });
          }
        },
        attaching: {
          detach: () => {
            this._fsm.transition('detaching');
            this._detachLink();
            this._fsm.transition('detached');
          },
          attach: () => this._fsm.deferUntilTransition('attached')
        },
        attached: {
          _onEnter: () => {
            this._linkObject.on('detached', this._detachHandler);
            if (this._attachCallback) {
              let callback = this._attachCallback;
              callback();
            }

            let toSend = this._messageQueue.shift();
            while (toSend) {
              this._fsm.handle('send', toSend.message, toSend.to, toSend.callback);
              toSend = this._messageQueue.shift();
            }
          },
          _onExit: () => {
            this._linkObject.removeListener('detached', this._detachHandler);
          },
          attach: (callback) => callback(),
          detach: () => {
            this._fsm.transition('detaching');
            this._detachLink();
            this._fsm.transition('detached');
          },
          send: (message, callback) => {
            this._linkObject.send(message)
                            .then((state) => {
                              this._safeCallback(callback, null, new results.MessageEnqueued(state));
                              return null;
                            })
                            .catch((err) => {
                              /*Codes_SRS_NODE_IOTHUB_AMQPCOMMON_16_007: [If sendEvent encounters an error before it can send the request, it shall invoke the `done` callback function and pass the standard JavaScript Error object with a text description of the error (err.message).]*/
                              this._safeCallback(callback, err);
                            });
          }
        },
        detaching: {
          _onEnter: () => {
            let toSend = this._messageQueue.shift();
            while (toSend) {
              // TODO need a custom error for the client to handle
              toSend.callback(new Error('link is being detached'));
              toSend = this._messageQueue.shift();
            }
          },
          '*': () => this._fsm.deferUntilTransition('detached')
        }
      }
    });
  }

  detach(): void {
    this._fsm.handle('detach');
  }

  attach(callback: (err?: Error) => void): void {
    this._fsm.handle('attach', callback);
  }

  send(message: AmqpMessage, callback: SendCallback): void {
    this._fsm.handle('send', message, callback);
  }

  private _attachLink(endpoint: string, linkOptions: any, done: (err?: Error) => void): void {
    /*Codes_SRS_NODE_COMMON_AMQP_16_032: [The `attachSenderLink` method shall call the `done` callback with a `NotConnectedError` object if the amqp client is not connected when the method is called.]*/
    let connectionError = null;
    let clientErrorHandler = (err) => {
      connectionError = err;
    };
    /*Codes_SRS_NODE_COMMON_AMQP_16_007: [If send encounters an error before it can send the request, it shall invoke the `done` callback function and pass the standard JavaScript Error object with a text description of the error (err.message).]*/
    this._amqp10Client.on('client:errorReceived', clientErrorHandler);

    /*Codes_SRS_NODE_COMMON_AMQP_06_003: [The `attachSenderLink` method shall create a policy object that contain link options to be merged if the linkOptions argument is not falsy.]*/
    /*Codes_SRS_NODE_COMMON_AMQP_16_013: [The `attachSenderLink` method shall call `createSender` on the `amqp10` client object.]*/
    this._amqp10Client.createSender(endpoint, linkOptions)
      .then((sender) => {
        sender.on('detached', this._detachHandler);
        this._amqp10Client.removeListener('client:errorReceived', clientErrorHandler);
        if (!connectionError) {
          debug('Sender object created for endpoint: ' + endpoint);
          this._linkObject = sender;
        }

        /*Codes_SRS_NODE_COMMON_AMQP_16_015: [The `attachSenderLink` method shall call the `done` callback with a `null` error and the link object that was created if the link was attached successfully.]*/
        /*Codes_SRS_NODE_COMMON_AMQP_16_016: [The `attachSenderLink` method shall call the `done` callback with an `Error` object if the link object wasn't created successfully.]*/
        return done(connectionError);
      })
      .catch((err) => {
        /*Codes_SRS_NODE_IOTHUB_AMQPCOMMON_16_007: [If sendEvent encounters an error before it can send the request, it shall invoke the `done` callback function and pass the standard JavaScript Error object with a text description of the error (err.message).]*/
        let error: AmqpTransportError = new errors.NotConnectedError('AMQP: Could not create sender');
        error.amqpError = err;
        return done(error);
      });
  }

  private _detachHandler(detachEvent: any): void {
    this._linkObject = null;
    if (detachEvent.error) {
      this.emit('error', detachEvent.error);
    }
    this._fsm.transition('detached');
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
