// Мост между Gecko-приложением и wasm-каркасом.
// На реальном телефоне Module ещё не существует — экран останется чёрным.
const canvas = document.getElementById('scr');
const ctx = canvas.getContext('2d');
let Module = window.Module || null;

function frame(){
  if(Module && Module._vga_poll){
    // гипотетический рендер: wasm пишет RGB565 в память, мы тянем его в ImageData
    requestAnimationFrame(frame);
  } else {
    ctx.fillStyle='#111'; ctx.fillRect(0,0,320,240);
    ctx.fillStyle='#0f0'; ctx.font='14px monospace';
    ctx.fillText('KaDOS skeleton built', 20, 120);
    ctx.fillText('Fallout 2 NOT supported', 20, 140);
  }
}
frame();
