// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

'use strict';

import { EventEmitter } from 'events';
import * as util from 'util';
import Int64 = require ('node-int64');
import * as amqp10 from 'amqp10';
import machina = require('machina');


import { endpoint, errors, results, Message } from 'azure-iot-common';
import { Amqp as BaseAmqpClient, translateError, AmqpMessage } from 'azure-iot-amqp-base';
import { ClientConfig } from 'azure-iot-device';

import * as querystring from 'querystring';
import * as url from 'url';
import * as uuid from 'uuid';
import * as dbg from 'debug';
const debug = dbg('azure-iot-device:twin');;

/* Codes_SRS_NODE_DEVICE_MQTT_TWIN_RECEIVER_18_009: [** The subscribed topic for `response` events shall be '$iothub/twin/res/#' **]** */
const responseTopic = '$iothub/twin/res';

/**
 * @class        module:azure-iot-device-mqtt.AmqpTwinReceiver
 * @classdesc    Acts as a receiver for device-twin traffic
 *
 * @param {Object} config   configuration object
 * @fires AmqpTwinReceiver#subscribed   an MQTT topic has been successfully subscribed to
 * @fires AmqpTwinReceiver#error    an error has occured while subscribing to an MQTT topic
 * @fires AmqpTwinReceiver#response   a response message has been received from the service
 * @fires AmqpTwinReceiver#post a post message has been received from the service
 * @throws {ReferenceError} If client parameter is falsy.
 *
 */
export class AmqpTwinReceiver extends EventEmitter {
  static errorEvent: string = 'error';
  static responseEvent: string = 'response';
  static postEvent: string = 'post';
  static subscribedEvent: string = 'subscribed';

  private _client: BaseAmqpClient;
  private _upstreamLinkOption: any;
  private _downstreamLinkOption: any;
  private _boundMessageHandler: Function;
  private _upstreamEndpoint: string;
  private _downstreamEndpoint: string;
  private _upstreamAmqpLink: any;
  private _downstreamAmqpLink: any;
  private _fsm: any;
  private _internalOperations: {[key: string]: () => void};

  constructor(config: ClientConfig, client: any) {
    super();
    /* Codes_SRS_NODE_DEVICE_MQTT_TWIN_RECEIVER_18_001: [** The `AmqpTwinReceiver` constructor shall accept a `client` object **]** */
    /* Codes_SRS_NODE_DEVICE_MQTT_TWIN_RECEIVER_18_002: [** The `AmqpTwinReceiver` constructor shall throw `ReferenceError` if the `client` object is falsy **]** */
    if (!client) {
      throw new ReferenceError('required parameter is missing');
    }
    this._client = client;
    this._internalOperations = {};
    this._upstreamAmqpLink = null;
    this._downstreamAmqpLink = null;
    this._upstreamEndpoint = endpoint.devicePath(config.deviceId) + '/twin/';
    this._downstreamEndpoint = endpoint.devicePath(config.deviceId) + '/twin/';
    this._upstreamLinkOption = {
      attach: {
        properties: {
          'com.microsoft:channel-correlation-id' : 'twin:',
          'com.microsoft:api-version' : endpoint.apiVersion
        },
        sndSettleMode: amqp10.Constants.senderSettleMode.settled,
        rcvSettleMode: amqp10.Constants.receiverSettleMode.autoSettle
      }
    };

    this._downstreamLinkOption = {
      attach: {
        properties: {
          'com.microsoft:channel-correlation-id' : 'twin:',
          'com.microsoft:api-version' : endpoint.apiVersion
        },
        sndSettleMode: amqp10.Constants.senderSettleMode.settled,
        rcvSettleMode: amqp10.Constants.receiverSettleMode.autoSettle
      }
    };

    this._fsm = new machina.Fsm({
      namespace: 'device-twin-client',
      initialState: 'disconnected',
      states: {
        'disconnected': {
          _onEnter: () => {
            if ((EventEmitter.listenerCount(this, AmqpTwinReceiver.postEvent) + EventEmitter.listenerCount(this, AmqpTwinReceiver.responseEvent)) > 0) {
              this._fsm.transition('connecting');
            }
          },
          handleNewListener: (eventName) => {
            if ((eventName === AmqpTwinReceiver.responseEvent) || (eventName === AmqpTwinReceiver.postEvent)) {
              this._fsm.deferUntilTransition('connected');
              this._fsm.transition('connecting');
            }
          },
          handleRemoveListener: () => {
            debug('remove listener call in disconnected stated')
          },
          sendTwinRequest: () => {
            this._fsm.deferUntilTransition('connected');
            this._fsm.transition('connecting');
          },
          handleDownstreamLinkDetach: () => {
            debug('Got a downstream link detached while disconnected.');
          }
        },
        'connecting': {
          _onEnter: () => {
            const linkCorrelationId: string  = uuid.v4().toString();
            this._upstreamLinkOption.attach.properties['com.microsoft:channel-correlation-id'] = 'twin:' + linkCorrelationId;
            this._downstreamLinkOption.attach.properties['com.microsoft:channel-correlation-id'] = 'twin:' + linkCorrelationId;
            this._client.attachReceiverLink( this._downstreamEndpoint, this._downstreamLinkOption, (receiverLinkError?: Error, receiverTransportObject?: any): void => {
              if (receiverLinkError) {
                this._handleError(receiverLinkError);
                this._fsm.transition('disconnected');
                this.emit('errorReceived', receiverLinkError);
              } else {
                this._downstreamAmqpLink = receiverTransportObject;
                this._downstreamAmqpLink.on('detached',this._onAmqpDetached.bind(this));
                this._client.attachSenderLink( this._upstreamEndpoint, this._upstreamLinkOption, (senderLinkError?: Error, senderTransportObject?: any): void => {
                  if (senderLinkError) {
                    this._handleError(senderLinkError);
                    this._fsm.transition('disconnected');
                    this.emit('errorReceived', receiverLinkError);
                  } else {
                    this._upstreamAmqpLink = senderTransportObject;
                    this._fsm.transition('connected');
                  }
                });
              }
            });
          },
          handleNewListener: () => {
            this._fsm.deferUntilTransition('connected');
          },
          handleRemoveListener: () => {
            this._fsm.deferUntilTransition('connected');
          },
          sendTwinRequest: () => {
            this._fsm.deferUntilTransition('connected');
          }
        },
        'connected': {
          _onEnter: () => {
            this._downstreamAmqpLink.on('message', this._boundMessageHandler);
          },
          handleNewListener: (eventName) => {
            if (eventName === AmqpTwinReceiver.responseEvent) {
              this.emit(AmqpTwinReceiver.subscribedEvent, { 'eventName' : AmqpTwinReceiver.responseEvent, 'transportObject' : this._upstreamAmqpLink });
            } else if (eventName === AmqpTwinReceiver.postEvent) {
              //
              // We need to send a PUT request upstream to enable notification of desired property changes
              // from the cloud. Then we have to wait for the (hopefully) successful response to self request.
              //
              // Only at this point can we emit an successful subscribe to the agnostic twin code that is utilizing this receiver.
              //
              const correlationId = uuid.v4().toString();
              this._internalOperations[correlationId] = () => {this.emit(AmqpTwinReceiver.subscribedEvent, { 'eventName' : AmqpTwinReceiver.postEvent, 'transportObject' : this._upstreamAmqpLink })};
              this.sendTwinRequest('PUT', '/notifications/twin/properties/desired', {$rid: correlationId}, ' ');
            }
          },
          handleRemoveListener: (eventName) => {
            if ((eventName === AmqpTwinReceiver.postEvent) && EventEmitter.listenerCount(this, AmqpTwinReceiver.postEvent) === 0) {
              const correlationId = uuid.v4().toString();
              this._internalOperations[correlationId] = () => {debug('Turned off desired property notification')};
              this.sendTwinRequest('DELETE', '/notifications/twin/properties/desired', {$rid: correlationId}, ' ');
            }
          },
          sendTwinRequest: (method, resource, properties, body, done) => {
            this._sendTwinRequest(method, resource, properties, body, done);
          },
          handleDownstreamLinkDetach: () => {
            this._fsm.transition('disconnecting');
          },
          _onExit: () => {
            this._downstreamAmqpLink.off('message', this._boundMessageHandler);
          }
        },
        'disconnecting': {
          _onEnter: () => {
            this._client.detachSenderLink( this._upstreamEndpoint, (err: Error, result?:any) => {
              if (err) {
                debug('we received an error for the detach of the upstream link during the disconnect.  Moving on to the downstream link.');
              }
              this._client.detachReceiverLink(this._downstreamAmqpLink,  (err: Error, result?:any) => {
                if (err) {
                  debug('we received an error for the detach of the downstream link during the disconnect.');
                }
              });
            });
            this._fsm.transition('disconnected');
          },
          handleNewListener: () => {
            this._fsm.deferUntilTransition('connected');
          },
          handleRemoveListener: () => {
            this._fsm.deferUntilTransition('connected');
          },
          sendTwinRequest: () => {
            this._fsm.deferUntilTransition('connected');
          }
        }
      }
    });

    this.on('newListener', this._handleNewListener.bind(this));
    this.on('removeListener', this._handleRemoveListener.bind(this));
    this._boundMessageHandler = this._onAmqpMessage.bind(this); // need to save this so that calls to add & remove listeners can be matched by the EventEmitter.

  }

  private _handleNewListener(eventName: string): void {
    this._fsm.handle('handleNewListener', eventName);
  }

  private _handleRemoveListener(eventName: string): void {
    this._fsm.handle('handleRemoveListener', eventName);
  }

  private _startListeningIfFirstSubscription(): void {
    // this method is called _before_ the new listener is added to the array of listeners
    if ((EventEmitter.listenerCount(this, AmqpTwinReceiver.responseEvent) + EventEmitter.listenerCount(this, AmqpTwinReceiver.postEvent)) === 2) {
      this._downstreamAmqpLink.on('message', this._boundMessageHandler);
    }
  }

  private _stopListeningIfLastUnsubscription(): void {
    // this method is called _after_ the listener is removed from the array of listeners
    if ((EventEmitter.listenerCount(this, AmqpTwinReceiver.responseEvent) + EventEmitter.listenerCount(this, AmqpTwinReceiver.postEvent)) === 0) {
      this._downstreamAmqpLink.removeListener('message', this._boundMessageHandler);
    }
  }

  private _onAmqpMessage(message: Message): void {
    //
    // The ONLY time we should see a message on the downstream link without a correlationId is if the message is a desired property delta update.
    //
    const correlationId: string = message.correlationId;
    if (correlationId) {
      this._onResponseMessage(message);
    } else if (message.hasOwnProperty('data')) {
      this._onPostMessage(message);
    } else {
      //
      // Can't be any message we know what to do with.  Just drop it on the floor.
      //
      debug('malformed response message recevied from service: ' + JSON.stringify(message));
    }
  }

  private _onResponseMessage(message: Message): void {
    debug('onResponseMessage: The downstream message is: ' + JSON.stringify(message));
    //
    // We KNOW that the message has been pre-checked for a correlation id.
    //
    if (this._internalOperations[message.correlationId]) {
      const callback = this._internalOperations[message.correlationId];
      delete this._internalOperations[message.correlationId];
      callback();
    } else {
      //
      // As far as the status goes, if we get anything at all we gen up our own status.  The
      // service doesn't want going to give us one.
      //
      const response = {
        'topic': responseTopic,
        'status': 200,
        '$rid': message.correlationId,
        'body': message.data
      }

      /* Codes_SRS_NODE_DEVICE_MQTT_TWIN_RECEIVER_18_004: [** If there is a listener for the `response` event, a `response` event shall be emitted for each response received. **]** */
      this.emit(AmqpTwinReceiver.responseEvent, response);
    }
  }

  private _onPostMessage(message: Message): void {
    //
    // We got a desired property delta update notification from the service.
    //
    debug('onPostMessage: The downstream message is: ' + JSON.stringify(message));
    this.emit(AmqpTwinReceiver.postEvent, message.data);
  }

  private _handleError(err: Error): void {
    /* Codes_SRS_NODE_DEVICE_MQTT_TWIN_RECEIVER_18_023: [** If the `error` event is subscribed to, an `error` event shall be emitted if any asynchronous subscribing operations fails. **]** */
    /* Codes_SRS_NODE_DEVICE_MQTT_TWIN_RECEIVER_18_024: [** When the `error` event is emitted, the first parameter shall be an error object obtained via the MQTT `translateErrror` module. **]** */
    debug('in twinReceiver:amqp:_handleError: error is: ' + JSON.stringify(err));
    this.emit(AmqpTwinReceiver.errorEvent, translateError('recevied an error from the amqp transport: ', err));
  }

  private _onAmqpDetached(): void {
    this._fsm.handle('handleDownstreamLinkDetach');
  }

  private _sendTwinRequest(method: string, resource: string, properties: { [key: string]: string }, body: any, done?: (err?: Error, result?: any) => void): void {
    /* Codes_SRS_NODE_DEVICE_AMQP_06_012: [The `sendTwinRequest` method shall not throw `ReferenceError` if the `done` callback is falsy.] */
    /* Codes_SRS_NODE_DEVICE_AMQP_06_013: [The `sendTwinRequest` method shall throw an `ReferenceError` if the `method` argument is falsy.] */
    /* Codes_SRS_NODE_DEVICE_AMQP_06_014: [The `sendTwinRequest` method shall throw an `ReferenceError` if the `resource` argument is falsy.] */
    /* Codes_SRS_NODE_DEVICE_AMQP_06_015: [The `sendTwinRequest` method shall throw an `ReferenceError` if the `properties` argument is falsy.] */
    /* Codes_SRS_NODE_DEVICE_AMQP_06_016: [The `sendTwinRequest` method shall throw an `ReferenceError` if the `body` argument is falsy.] */
    if (!method || !resource || !properties || !body) {
      throw new ReferenceError('required parameter is missing');
    }

    /* Codes_SRS_NODE_DEVICE_AMQP_06_017: [The `sendTwinRequest` method shall throw an `ArgumentError` if the `method` argument is not a string.] */
    /* Codes_SRS_NODE_DEVICE_AMQP_06_018: [The `sendTwinRequest` method shall throw an `ArgumentError` if the `resource` argument is not a string.] */
    if (!util.isString(method) || !util.isString(resource)) {
      throw new errors.ArgumentError('required string parameter is not a string');
    }

    /* Codes_SRS_NODE_DEVICE_AMQP_06_019: [The `sendTwinRequest` method shall throw an `ArgumentError` if the `properties` argument is not a an object.] */
    if (!util.isObject(properties)) {
      throw new errors.ArgumentError('required properties parameter is not an object');
    }

    let amqpMessage = new AmqpMessage();
    amqpMessage.messageAnnotations = {};
    amqpMessage.properties = {};

    /* Codes_SRS_NODE_DEVICE_AMQP_06_020: [The `method` argument shall be the value of the amqp message `operation` annotation.] */
    /* Codes_SRS_NODE_DEVICE_AMQP_06_021: [The `resource` argument shall be the value of the amqp message `resource` annotation.] */
    //
    // Amqp requires that the resouce designation NOT be terminated by a slash.  The agnositic twin client was terminating the
    // resources with a slash which worked just dandy for MQTT.
    //
    // We need to cut off a terminating slash.  If we cut off a terminating slash and the length of resouce is zero then simply
    // don't specify a resource.
    //
    amqpMessage.messageAnnotations['operation'] = method;
    var localResource: string = resource;
    if (localResource.length > 0) {
      if (localResource.substr(localResource.length-1,1) === '/') {
        localResource = localResource.slice(0,localResource.length-1);
      }
      if (localResource.length > 0) {
        amqpMessage.messageAnnotations['resource'] = localResource;
      }
    }
    if (method === 'PATCH') {
      amqpMessage.messageAnnotations['version'] = null;
    }
    Object.keys(properties).forEach((key) => {
      /* Codes_SRS_NODE_DEVICE_AMQP_06_028: [The `sendTwinRequest` method shall throw an `ArgumentError` if any members of the `properties` object fails to serialize to a string.] */
      if (!util.isString(properties[key]) && !util.isNumber(properties[key]) && !util.isBoolean(properties[key])) {
        throw new errors.ArgumentError('required properties object has non-string properties');
      }

      /* Codes_SRS_NODE_DEVICE_AMQP_06_022: [All properties (with one exception), shall be set as the part of the annotation map of the amqp message.] */
      /* Codes_SRS_NODE_DEVICE_AMQP_06_023: [The exception is that the rid property shall be set as the `correlationId` in the properties map of the amqp message.] */
      if (key === '$rid') {
        amqpMessage.properties.correlationId = properties[key].toString();
      } else {
        amqpMessage.messageAnnotations[key] = properties[key];
      }
    });

    /* Codes_SRS_NODE_DEVICE_AMQP_06_024: [The `body` shall be value of the body of the amqp message.] */
    amqpMessage.body = body.toString();

    /* Codes_SRS_NODE_DEVICE_AMQP_06_025: [The amqp message will be sent upstream to the IoT Hub the amqp client `send`.]*/
    this.send(amqpMessage, done);
  }

  /**
   * @method          module:azure-iot-device-amqp.Amqp#sendTwinRequest
   * @description     Send a device-twin specific messager to the IoT Hub instance
   *
   * @param {String}        method    name of the method to invoke ('PUSH', 'PATCH', etc)
   * @param {String}        resource  name of the resource to act on (e.g. '/properties/reported/') with beginning and ending slashes
   * @param {Object}        properties  object containing name value pairs for request properties (e.g. { 'rid' : 10, 'index' : 17 })
   * @param {String}        body  body of request
   * @param {Function}      done  the callback to be invoked when this function completes.
   *
   * @throws {ReferenceError}   One of the required parameters is falsy
   * @throws {ArgumentError}  One of the parameters is an incorrect type
   */
  sendTwinRequest(method: string, resource: string, properties: { [key: string]: string }, body: any, done?: (err?: Error, result?: any) => void): void {
    this._fsm.handle('sendTwinRequest', method, resource, properties, body, done);
  }

  /**
   * @class              module:azure-iot-device-amqp.AmqpTwinReceiver#send
   * @description        Sends a message to the IoT Hub instance.
   *
   * @param {Message}   message   The message to send.
   * @param {Function}  done      Called when the message is sent or if an error happened.
   */
  send(message: AmqpMessage, done: (err: Error | null, result?: any) => void): void {
    this._upstreamAmqpLink.send(message)
      .then((state) => {
        debug(' amqp-twin-receiver: Good dispostion on the amqp message send: ' + JSON.stringify(state));
        this._safeCallback(done, null, new results.MessageEnqueued(state));
        return null;
      })
      .catch((err) => {
        debug(' amqp-twin-receiver: Bad dispostion on the amqp message send: ' + err);
        /*Codes_SRS_NODE_IOTHUB_AMQPCOMMON_16_007: [If sendEvent encounters an error before it can send the request, it shall invoke the `done` callback function and pass the standard JavaScript Error object with a text description of the error (err.message).]*/
        this._safeCallback(done, err);
      });
  }

  /*Codes_SRS_NODE_COMMON_AMQP_16_011: [All methods should treat the `done` callback argument as optional and not throw if it is not passed as argument.]*/
  private _safeCallback(callback: (err: Error | null, result?: any) => void, error?: Error | null, result?: any): void {
    if (callback) {
      process.nextTick(() => callback(error, result));
    }
  }
}
