// turn the image tags containing these SVGs back into inline svg tags
// to e.g. modify their colors with css
window.addEventListener("load", () => {
  deSVG(".piano_svg", true);
  deSVG(".wave_svg", true);
  deSVG(".automation_svg", true);
});
