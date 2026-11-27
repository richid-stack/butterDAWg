(function plugin(id, audioNode) {
    let slider_param1 = document.querySelector("#" + id + " #slider-param1");
    let output_param1 = document.querySelector("#" + id + " #value-param1");
    const level = audioNode.parameters.get("level");
    // show where the parameter is now: a project may have set it before this window was opened, and an undo or redo changes it while it is open
    const refresh = () => {
        slider_param1.value = Math.round(level.value * 100);
        output_param1.textContent = slider_param1.value;
    };
    refresh();
    slider_param1.addEventListener("input", (e) => {
        output_param1.textContent = e.target.value;
        level.value = e.target.value / 100;
    });
    return { refresh };
})
