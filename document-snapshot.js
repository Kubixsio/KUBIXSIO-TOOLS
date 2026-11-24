(function () {
  'use strict';
  // Shared, on-demand read-only snapshot. It does not accept or persist an AI preview.
  window.ktxDocumentSnapshot = Object.freeze({capture: function () {
    return window.ktxAiReviewSession.capture({disableButtons: false});
  }});
})();
