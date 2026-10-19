'use strict';

/**
 * Deliberately dumb transfer protocol: one JSON object per line over a unix
 * socket. Request  -> {"id":1,"method":"start","params":{...}}
 *                   Response -> {"id":1,"ok":true,"result":{...}}
 *                               {"id":1,"ok":false,"error":{"message":"...","code":"..."}}
 *
 * This replaces the reference implementation's axon RPC + pub/sub with one
 * socket. Events (logs, state changes) are not streamed yet: that is M3.
 */

const NEWLINE = '\n';

function encode(message) {
  return JSON.stringify(message) + NEWLINE;
}

/** Turns a byte stream into JSON messages. Returns a detach() function. */
function createDecoder(stream, onMessage, onError) {
  let buffer = '';
  const onData = (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf(NEWLINE)) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        if (onError) onError(new Error(`invalid JSON frame: ${err.message}`));
        continue;
      }
      onMessage(parsed);
    }
  };
  stream.setEncoding('utf8');
  stream.on('data', onData);
  return () => stream.removeListener('data', onData);
}

function ok(id, result) {
  return { id, ok: true, result: result === undefined ? null : result };
}

function fail(id, message, code) {
  return { id, ok: false, error: { message: String(message), code: code || 'error' } };
}

module.exports = { encode, createDecoder, ok, fail };
