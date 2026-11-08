// Slipway: signed-in visitors of the home page go straight to the pull request list.
(function () {
  var signed = document.querySelector('meta[name="slipway-signed-in"]');
  var sub = (document.querySelector('meta[name="slipway-sub-url"]') || {}).content || '';
  if (signed && signed.content === '1' && (location.pathname === sub + '/' || location.pathname === sub)) {
    location.replace(sub + '/pulls');
  }
})();
