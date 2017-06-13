var EventEmitter = require('events').EventEmitter;
var assert = require('chai').assert;
var sinon = require('sinon');
var SenderLink = require('../lib/sender_link.js').SenderLink;
var AmqpMessage = require('../lib/amqp_message.js').AmqpMessage;

describe('SenderLink', function() {
  describe('constructor', function() {
    it('inherits from EventEmitter', function() {
      var link = new SenderLink('link', null, {});
      assert.instanceOf(link, EventEmitter);
    });

    it('implements the AmqpLink interface', function() {
      var link = new SenderLink('link', null, {});
      assert.isFunction(link.attach);
      assert.isFunction(link.detach);
    });

    it('initializes the internal state machine to a \'detached\' state', function() {
      var link = new SenderLink('link', null, {});
      assert.strictEqual(link._fsm.state, 'detached');
    });
  });

  describe('attach', function() {
    it('attaches a new link using the amqp10.AmqpClient object', function(testCallback) {
      var fakeLinkAddress = 'link';
      var fakeLinkOptions = {};
      var fakeAmqp10Client = new EventEmitter();
      fakeAmqp10Client.createSender = sinon.stub().resolves(new EventEmitter());

      var link = new SenderLink(fakeLinkAddress, fakeLinkOptions, fakeAmqp10Client);
      link.attach(function() {
        assert(fakeAmqp10Client.createSender.calledWith(fakeLinkAddress, fakeLinkOptions));
        testCallback();
      });
    });

    it('does not create a new link if already attached', function(testCallback) {
      var fakeLinkObj = new EventEmitter();
      var fakeAmqp10Client = new EventEmitter();
      fakeAmqp10Client.createSender = sinon.stub().resolves(fakeLinkObj);

      var link = new SenderLink('link', null, fakeAmqp10Client);
      link.attach(function() {
        // now successfully attached
        assert.isTrue(fakeAmqp10Client.createSender.calledOnce);
        link.attach(function() {
          assert.isTrue(fakeAmqp10Client.createSender.calledOnce); // would be false if create sender had been called twice
          testCallback();
        });
      });
    });

    it('calls the callback with an error if attaching the link fails', function(testCallback) {
      var fakeError = new Error('fake error');
      var fakeAmqp10Client = new EventEmitter();
      fakeAmqp10Client.createSender = sinon.stub().rejects(fakeError);

      var link = new SenderLink('link', null, fakeAmqp10Client);
      link.attach(function(err) {
        assert.strictEqual(err, fakeError);
        testCallback();
      });
    });

    it('calls the callback with an error if the client emits an error while attaching the link', function(testCallback) {
      var fakeError = new Error('fake error');
      var fakeAmqp10Client = new EventEmitter();
      fakeAmqp10Client.createSender = function () {
        return new Promise(function(resolve, reject) {
          fakeAmqp10Client.emit('client:errorReceived', fakeError);
          resolve(new EventEmitter());
        });
      };

      var link = new SenderLink('link', null, fakeAmqp10Client);
      link.attach(function(err) {
        assert.strictEqual(err, fakeError);
        testCallback();
      });
    });

    it('subscribes to the detach and errorReceived events', function(testCallback) {
      var fakeLinkObj = new EventEmitter();
      sinon.spy(fakeLinkObj, 'on');
      var fakeAmqp10Client = new EventEmitter();
      fakeAmqp10Client.createSender = sinon.stub().resolves(fakeLinkObj);

      var link = new SenderLink('link', {}, fakeAmqp10Client);
      link.attach(function() {
        assert(fakeLinkObj.on.calledWith('detached'));
        assert(fakeLinkObj.on.calledWith('errorReceived'));
        testCallback();
      });
    });

    it('fails messages in the queue with its own error if the link cannot be attached', function (testCallback) {
      var fakeLinkObj = new EventEmitter();
      var fakeError = new Error('fake error');
      var fakeAmqp10Client = new EventEmitter();
      var message1Failed = false;
      var message2Failed = false;
      var unlockReject = null;
      fakeAmqp10Client.createSender = function () {
        return new Promise(function (resolve, reject) {
          unlockReject = reject; // will lock the state machine into 'attaching' until we can reject.
        });
      };

      var link = new SenderLink('link', {}, fakeAmqp10Client);
      link.attach(function(err) {
        assert.isTrue(message1Failed);
        assert.isTrue(message2Failed);
        assert.strictEqual(err, fakeError);
      });
      link.send(new AmqpMessage(''), function (err) {
        message1Failed = true;
        assert.strictEqual(err, fakeError);
      });
      link.send(new AmqpMessage(''), function (err) {
        message2Failed = true;
        assert.strictEqual(err, fakeError);
        testCallback();
      });
      unlockReject(fakeError);
    });
  });

  describe('detach', function() {
    it('detaches the link if it is attached', function(testCallback) {
      var fakeLinkObj = new EventEmitter();
      fakeLinkObj.forceDetach = sinon.stub();
      var fakeAmqp10Client = new EventEmitter();
      fakeAmqp10Client.createSender = sinon.stub().resolves(fakeLinkObj);

      var link = new SenderLink('link', {}, fakeAmqp10Client);
      link.attach(function() {
        link.detach();
        assert(fakeLinkObj.forceDetach.calledOnce);
        testCallback();
      });
    });

    it('does not do anything if the link is already detached', function() {
      var fakeAmqp10Client = new EventEmitter();
      fakeAmqp10Client.createSender = function () { assert.fail('should not try to create a sender'); };

      var link = new SenderLink('link', {}, fakeAmqp10Client);
      link.detach();
    })
  });

  describe('send', function() {
    it('automatically attaches the link if it is detached', function(testCallback) {
      var fakeLinkObj = new EventEmitter();
      fakeLinkObj.send = sinon.stub().resolves();
      var fakeAmqp10Client = new EventEmitter();
      fakeAmqp10Client.createSender = sinon.stub().resolves(fakeLinkObj);

      var link = new SenderLink('link', {}, fakeAmqp10Client);
      link.send(new AmqpMessage(''), function() {
        assert(fakeAmqp10Client.createSender.calledOnce);
        assert(fakeLinkObj.send.calledOnce);
        testCallback();
      });
    });

    it('sends the message passed as argument and calls the callback if successful', function(testCallback) {
      var fakeMessage = new AmqpMessage({});
      var fakeLinkObj = new EventEmitter();
      fakeLinkObj.send = sinon.stub().resolves();
      var fakeAmqp10Client = new EventEmitter();
      fakeAmqp10Client.createSender = sinon.stub().resolves(fakeLinkObj);

      var link = new SenderLink('link', {}, fakeAmqp10Client);
      link.attach(function() {
        link.send(fakeMessage, function() {
          assert(fakeLinkObj.send.calledWith(fakeMessage));
          testCallback();
        });
      });
    });

    it('queues messages and send them in order when the link is attached', function(testCallback) {
      var fakeMessage1 = new AmqpMessage({});
      var fakeMessage2 = new AmqpMessage({});
      var fakeLinkObj = new EventEmitter();
      var unlockResolve = null;
      fakeLinkObj.send = sinon.stub().resolves();
      var fakeAmqp10Client = new EventEmitter();
      fakeAmqp10Client.createSender = function() {
        return new Promise(function(resolve, reject) {
          unlockResolve = resolve;
        });
      };

      var link = new SenderLink('link', {}, fakeAmqp10Client);
      link.attach(function() {}); // Will be stuck in attaching until unlockResolve is called.
      link.send(fakeMessage1, function() {});
      link.send(fakeMessage2, function() {
        assert(fakeLinkObj.send.firstCall.calledWith(fakeMessage1));
        assert(fakeLinkObj.send.secondCall.calledWith(fakeMessage2));
        testCallback();
      });
      unlockResolve(fakeLinkObj);
    });

    it('calls the callback with an error if the amqp10 link fails to send the message', function (testCallback) {
      var fakeMessage = new AmqpMessage({});
      var fakeLinkObj = new EventEmitter();
      var fakeError = new Error('fake send failure');
      fakeLinkObj.send = sinon.stub().rejects(fakeError);
      var fakeAmqp10Client = new EventEmitter();
      fakeAmqp10Client.createSender = sinon.stub().resolves(fakeLinkObj);

      var link = new SenderLink('link', {}, fakeAmqp10Client);
      link.attach(function() {
        link.send(fakeMessage, function(err) {
          assert.strictEqual(err, fakeError);
          testCallback();
        });
      });
    });
  });

  describe('events', function() {
    describe('detached', function() {
      it('returns to the detached state when the detached event is received', function(testCallback) {
        var fakeLinkObj = new EventEmitter();
        var fakeError = new Error('link is now detached');
        var fakeAmqp10Client = new EventEmitter();
        fakeAmqp10Client.createSender = sinon.stub().resolves(fakeLinkObj);

        var link = new SenderLink('link', null, fakeAmqp10Client);
        link.attach(function() {
          // now successfully attached
          assert.isTrue(fakeAmqp10Client.createSender.calledOnce);
          fakeLinkObj.emit('detached', { });
          // now detached
          link.attach(function() {
            assert.isTrue(fakeAmqp10Client.createSender.calledTwice);
            testCallback();
          });
        });
      });
    });

    describe('errorReceived', function() {

    });
  });
});