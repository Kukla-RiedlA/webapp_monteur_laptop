'use strict';

const { parseParameterFile } = require('../anlagenstamm-parameter-parser');

const MIN_CONTENT_ENTRIES = 3;
const STRICT_PARAM_EXT_RE = /\.(csv|pa3|pa4|pa5|pa6|pa7|pal)$/i;

function isParameterListBuffer(fileName, buffer) {
  if (STRICT_PARAM_EXT_RE.test(String(fileName || '').trim())) return true;
  if (!buffer || !buffer.length) return false;
  const parsed = parseParameterFile(buffer, { fileName });
  const entries = parsed && Array.isArray(parsed.entries) ? parsed.entries.length : 0;
  return !!(parsed && parsed.used_fab && entries >= MIN_CONTENT_ENTRIES);
}

module.exports = { isParameterListBuffer, MIN_CONTENT_ENTRIES };
