// Slipway: the merge box in a PR is replaced by a short note (merging happens on GitHub after promotion).
(function () {
  function addNote() {
    const box = document.querySelector('.pull-merge-box .merge-section');
    if (!box || box.querySelector('.slipway-promote-note')) return;
    const note = document.createElement('div');
    note.className = 'item slipway-promote-note';
    note.textContent = 'Approved PRs are promoted to GitHub from your Claude session.';
    box.prepend(note);
  }
  addNote();
  new MutationObserver(addNote).observe(document.body, { childList: true, subtree: true });
})();
