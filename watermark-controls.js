(function () {
  'use strict';
  let mode = 'corner';
  const opacity = {corner: 70, full: 50};
  const slider = document.getElementById('watermarkOpacity');
  const output = document.getElementById('watermarkOpacityValue');
  function render() {
    slider.value = opacity[mode];
    output.value = opacity[mode] + '%';
    document.getElementById('watermarkCorner').setAttribute('aria-pressed', String(mode === 'corner'));
    document.getElementById('watermarkFull').setAttribute('aria-pressed', String(mode === 'full'));
  }
  document.getElementById('watermarkCorner').addEventListener('click', function () { mode = 'corner'; render(); });
  document.getElementById('watermarkFull').addEventListener('click', function () { mode = 'full'; render(); });
  slider.addEventListener('input', function () {
    opacity[mode] = Math.max(0, Math.min(100, Math.round(Number(slider.value) / 5) * 5));
    render();
  });
  window.ktxWatermarkControls = Object.freeze({getOptions: function () { return {mode, opacity: opacity[mode]}; }});
  render();
})();
