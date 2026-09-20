import { normalize } from '../src/normalize.mjs';
import assert from 'node:assert/strict';
assert.equal(normalize(' Label '), 'Label');
