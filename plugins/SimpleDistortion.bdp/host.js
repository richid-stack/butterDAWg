(function plugin(id, audioNode) {
    let slider_param1 = document.querySelector("#" + id + " #slider-param1");
    let output_param1 = document.querySelector("#" + id + " #value-param1");
    const drive = audioNode.parameters.get("drive");
    // show where the parameter is now (a project may have set it before this window was opened)
    slider_param1.value = Math.round(drive.value * 100);
    output_param1.textContent = slider_param1.value;
    slider_param1.addEventListener("input", (e) => {
        output_param1.textContent = e.target.value;
        drive.value = e.target.value / 100;
    });
})
