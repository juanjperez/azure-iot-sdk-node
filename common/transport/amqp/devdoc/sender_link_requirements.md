# SenderLink Requirements

## Overview

The `SenderLink` class is internal to the SDK and shall be considered private. It shall not be used directly by clients of the SDK, who should instead rely on the higher-level constructs (`Client` classes provided by `azure-iot-device` and `azure-iothub`).

The `SenderLink` class implements a state machine that manages the underlying `amqp10` link object used to send messages to IoT Hub. It can be attached and detached manually, and will try to attach automatically if not already attached when calling `send`.

## Example usage

```typescript
import * as amqp10 from 'amqp10';
import { AmqpMessage } from './ampq_message';

const linkAddress = 'exampleAddress';
const amqp10Client = new amqp10.AmqpClient(null);

const senderLink = new SenderLink(linkAddress, null, amqp10Client);
senderLink.on('errorReceived', (err) => {
  console.error(err.toString());
});

senderLink.send(new AmqpMessage(''), linkAddress, (err) => {
  if (err) {
    console.error(err.toString());
  } else {
    console.log('message successfully sent');
  }
});
```

## Public Interface

### constructor(linkAddress: string, linkOptions: any, amqp10Client: amqp10.AmqpClient)

The `SenderLink` internal state machine shall be initialized in the `detached` state.

The `SenderLink` class shall inherit from `EventEmitter`.

The `SenderLink` class shall implement the `AmqpLink` interface.

### attach(callback: (err?: Error) => void): void

The `attach` method shall use the stored instance of the `amqp10.AmqpClient` object to attach a new link object with the `linkAddress` and `linkOptions` provided when creating the `SenderLink` instance.

If the `amqp10.AmqpClient` emits an `errorReceived` event during the time the link is attached, the `callback` function shall be called with this error.

The `SenderLink` object should subscribe to the `detached` event of the newly created `amqp10` link object.

The `SenderLink` object should subscribe to the `errorReceived` event of the newly created `amqp10` link object.

If the `amqp10.AmqpClient` fails to create the link the `callback` function shall be called with this error object.

### detach(): void

The `detach` method shall detach the link created by the `amqp10.AmqpClient` underlying object.

### send(message: AmqpMessage, callback: (err?: Error, result?: results.MessageEnqueued) => void): void

The `send` method shall use the link created by the underlying `amqp10.AmqpClient` to send the specified `message` to the IoT hub.

If the state machine is not in the `attached` state, the `SenderLink` object shall attach the link first and then send the message.

### Events

If a `detached` event is emitted by the `ampq10` link object, the `SenderLink` object shall return to the `detached` state.

If an `errorReceived` event is emitted by the `amqp10` link object, the `SenderLink` object shall emit an `error` event with this error.

### Internal state machine

While the link isn't attached, the messages passed to the `send` method shall be queued.

When the link gets attached, the messages shall be sent in the order they were queued.

If the link fails to attach and there are messages in the queue, the callback for each message shall be called with the error that caused the detach in the first place.
