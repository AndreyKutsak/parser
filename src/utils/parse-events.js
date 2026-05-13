/**
 * In-process event bus for streaming parse progress to SSE clients.
 *
 * Usage:
 *   Emitter (parser.service):  parseEvents.emit(taskId, { type, ...payload })
 *   Subscriber (SSE handler):  parseEvents.on(taskId, handler)
 *
 * Each taskId is a separate channel — concurrent parses don't interfere.
 */
const EventEmitter = require('events');
const bus = new EventEmitter();
bus.setMaxListeners(500); // allow many concurrent SSE connections
module.exports = bus;
