'use strict';

function sanitizeForWinAnsi(s) {
  return String(s == null ? '' : s)
    .replace(/\0/g, '')
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
    .replace(/\uFFFD/g, '')
    .replace(/\u2013/g, '-')
    .replace(/\u2014/g, '-')
    .replace(/\u2018|\u2019/g, "'")
    .replace(/\u201C|\u201D/g, '"')
    .replace(/[\u0160\u0161]/g, 's')
    .replace(/[\u010C\u010D\u0106\u0107]/g, 'c')
    .replace(/[\u017D\u017E]/g, 'z')
    .replace(/\u0111/g, 'd')
    .replace(/\u0141/g, 'L')
    .replace(/\u0142/g, 'l')
    .replace(/\u0152/g, 'O')
    .replace(/\u0153/g, 'o')
    .replace(/\u20AC/g, 'EUR')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, ' ');
}

module.exports = { sanitizeForWinAnsi };
