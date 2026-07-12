(function () {
  try {
    if (sessionStorage.getItem('os9booted')) return;
    sessionStorage.setItem('os9booted', '1');
  } catch (e) { return; }
  var el = document.createElement('div');
  el.className = 'splash';
  el.innerHTML = '<div class="card">Welcome to Dailey Weekly.<div class="bar"><i></i></div></div>';
  el.addEventListener('click', function () { el.remove(); });
  function mount() { document.body.appendChild(el); setTimeout(function () { el.remove(); }, 1600); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
