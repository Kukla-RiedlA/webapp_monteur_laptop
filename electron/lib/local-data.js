'use strict';

/** Stub für dispo-html-proxy (Dispo Desktop); Monteur nutzt eigene DB-Statistiken. */
function getLocalDataStats() {
  return {
    has_usable_data: false,
    jobs_local: 0,
    anlagenstamm_local: 0,
  };
}

module.exports = {
  getLocalDataStats,
};
