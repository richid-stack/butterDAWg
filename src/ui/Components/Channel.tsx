import { Channel } from "../../core/Channel";
import { globals, React } from "../../globals";
import { faderToGain, gainToFader, gainToDb, formatDb } from "../../engine/dsp";
import * as edit from "../../project/edit";
import { editText } from "../misc/editText";

const clamp = (num: number, min: number, max: number) => {return Math.max(min, Math.min(max, num));};

export class ChannelComponent {

    private element: HTMLElement;
    private channel: Channel;
    private selected: boolean;
    private index: number;
    private destroyed = false;

    constructor(channel: Channel, index = 0) {
        this.channel = channel;
        this.index = index;
        this.selected = false;
        this.createElement();
    }

    /** stops the level meter; the channel strip is going away (a project was closed) */
    destroy() {
        this.destroyed = true;
    }

    createElement() {
        this.element = <div className="channel">
            <div className="index_indicator">
                <p>0</p>
            </div>
            <div className="channel_label">
                <p>Insert 0</p>
            </div>
            <div className="channel_volume">
                <div className="channel_volume_indicator">
                    <div className="selection_indicator"></div>
                    <div className="indicator_top"></div>
                    <div className="indicator_bottom"></div>
                </div>
                <div className="channel_toggle">
                    <div className="channel_toggle_green"></div>
                </div>
                <div className="channel_pan">
                    <div className="channel_pan_knob"></div>
                </div>
            </div>
            <div className="channel_volume_slider">
                <div className="channel_volume_background">
                <div className="channel_volume_knob">
                    <div className="channel_volume_knob_peak"></div>
                </div>

                </div>
            </div>
            <div className="channel_links"></div>
        </div> as any;

        // volume level slider
        let volume_slider = this.element.querySelector(".channel_volume_knob") as HTMLElement;
        let channel = this.channel;
        // the fader is in decibels: 0 dB (unity) is a fifth of the way down from the top,
        // the top is +6 dB (see engine/dsp.ts for the law)
        function slider_move(e: MouseEvent) {
			let percent = clamp(((volume_slider.offsetTop + volume_slider.clientHeight/2) + e.movementY)/volume_slider.parentElement.clientHeight, 0, 1);
            channel.setVolume(faderToGain(1 - percent));
			globals.header_help_text.textContent = "Volume: " + formatDb(channel.getVolume());
            volume_slider.style.top = "calc(" + percent*100 + "% - " + volume_slider.clientHeight/2 + "px)";
		}
        volume_slider.addEventListener("mousedown", () => {
            // one drag is one undo step
            const drag = edit.volumeGesture(channel);
            document.addEventListener("mousemove", slider_move);
            document.addEventListener("mouseup", () => {
                document.removeEventListener("mousemove", slider_move);
                drag.end();
            }, { once: true });
        });
        volume_slider.addEventListener("mouseenter", () => {
			globals.header_help_text.textContent = "Volume: " + formatDb(this.channel.getVolume());
		});

        // toggle switch
        let toggle_switch = this.element.querySelector(".channel_toggle") as HTMLElement;
        toggle_switch.addEventListener("click", () => {
            edit.setChannelActive(this.channel, !this.channel.isActive()); // the strip redraws when the history changes
        });

        // panning knob
        let pan_knob = this.element.querySelector(".channel_pan") as HTMLElement;
        function pan_move(e: MouseEvent) {
			channel.setPanning(channel.getPanning() - e.movementY / 100);
			channel.setPanning(Math.max(Math.min(channel.getPanning(), 1.5), 0.5));
			if (channel.getPanning() < 1) {
				pan_knob.style["background"] =
					"#374045 conic-gradient(from 0deg at 50% 50%, #00000000 0%, #00000000 " +
					channel.getPanning() * 100 +
					"%, #5cff5c " +
					channel.getPanning() * 100 +
					"%, #5cff5c 100%)";
			} else {
				pan_knob.style["background"] =
					"#374045 conic-gradient(from 0deg at 50% 50%, #5cff5c 0%, #5cff5c " +
					(channel.getPanning() - 1) * 100 +
					"%, #00000000 " +
					(channel.getPanning() - 1) * 100 +
					"%, #00000000 100%)";
			}

			if (Math.round(channel.getPanning() * 100) === 100) {
				globals.header_help_text.textContent = "Panning: Centered";
			} else {
				globals.header_help_text.textContent =
					"Panning: " +
					Math.abs(Math.round(((channel.getPanning() - 1) / 0.5) * 100)) +
					"%" +
					(channel.getPanning() < 1 ? " left" : " right");
			}
		}
		pan_knob.addEventListener("mousedown", () => {
			const drag = edit.panGesture(channel);
			document.addEventListener("mousemove", pan_move);
			document.addEventListener("mouseup", () => {
				document.removeEventListener("mousemove", pan_move);
				drag.end();
			}, { once: true });
		});
        pan_knob.addEventListener("mouseenter", () => {
			if (Math.round(channel.getPanning() * 100) === 100) {
				globals.header_help_text.textContent = "Panning: Centered";
			} else {
				globals.header_help_text.textContent =
					"Panning: " +
					Math.abs(Math.round(((channel.getPanning() - 1) / 0.5) * 100)) +
					"%" +
					(channel.getPanning() < 1 ? " left" : " right");
			}
		});

        // rename: double click the name
        const label = this.element.querySelector(".channel_label p") as HTMLElement;
        label.addEventListener("dblclick", () => {
            editText(label, this.channel.getName(), (name) => edit.renameChannel(this.channel, name));
        });

        // channel selection
        this.element.addEventListener("mousedown", () => {
            this.select(true);
        });

        // level meter: the highest level of the last few milliseconds, in dB
        // from -60 (empty) to 0 (full); it falls back slowly so a hit stays visible
        let level_indicator = this.element.querySelector(".indicator_top") as HTMLElement;
        let shown = 0;
        const step = () => {
            if (this.destroyed) return;
            const peak = this.channel.getPeak();
            const level = clamp((gainToDb(peak) + 60) / 60, 0, 1);
            shown = Math.max(level, shown - 0.015);
            const height = ((1 - shown) * 100).toFixed(1) + "%";
            if (level_indicator.style.height !== height) {
                level_indicator.style.height = height;
            }
            requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    }

    getElement() {
        return this.element;
    }

    select(selected: boolean) {
		let volume_wrapper2 = this.element.querySelector(".channel_volume_indicator");
		let volume = this.element.querySelector(".selection_indicator");
		let volume_wrapper = this.element.querySelector(".channel_volume") as HTMLElement;
		let indicator = this.element.querySelector(".index_indicator") as HTMLElement;
		let indicator_text = indicator.querySelector("p");
		if (selected) {
			volume_wrapper2.classList.add("channel_volume_select2");
			volume.classList.add("channel_volume_select");
			this.element.style.backgroundColor = "#3d474c";
			this.element.style.borderColor = "#3c464c";
			indicator.style.background =
				"repeating-linear-gradient(45deg, transparent, transparent 2px, #0000000a 2px, #0000000a 4px) #636c71";
			indicator_text.style.color = "var(--text-color)";
			volume_wrapper.style.background =
				"linear-gradient(#3d474c, var(--bg-dark))";
		} else {
			volume_wrapper2.classList.remove("channel_volume_select2");
			volume.classList.remove("channel_volume_select");
			this.element.style.backgroundColor = "#374045";
			this.element.style.borderColor = "#313a40";
			indicator.style.background = "#636c71";
			indicator_text.style.color = "var(--bg-darker)";
			volume_wrapper.style.background =
				"linear-gradient(#374045, var(--bg-dark))";
		}
        this.selected = selected;
	}

    isSelected() {
        return this.selected;
    }

    update() {
        // the number and the name
        (this.element.querySelector(".index_indicator p") as HTMLElement).textContent = String(this.index);
        const label = this.element.querySelector(".channel_label p") as HTMLElement;
        if (!label.querySelector("input")) label.textContent = this.channel.getName();

        // update the toggle switch
        (this.element.querySelector(".channel_toggle_green") as HTMLElement).style.backgroundColor = this.channel.isActive() ? "#5cff5c" : "#1a501a";

        // update the panning knob
        let pan_knob = this.element.querySelector(".channel_pan") as HTMLElement;
        if (this.channel.getPanning() < 1) {
            pan_knob.style["background"] =
                "#374045 conic-gradient(from 0deg at 50% 50%, #00000000 0%, #00000000 " +
                this.channel.getPanning() * 100 +
                "%, #5cff5c " +
                this.channel.getPanning() * 100 +
                "%, #5cff5c 100%)";
        } else {
            pan_knob.style["background"] =
                "#374045 conic-gradient(from 0deg at 50% 50%, #5cff5c 0%, #5cff5c " +
                (this.channel.getPanning() - 1) * 100 +
                "%, #00000000 " +
                (this.channel.getPanning() - 1) * 100 +
                "%, #00000000 100%)";
        }

        // update the volume slider
        let volume_slider = this.element.querySelector(".channel_volume_knob") as HTMLElement;
        volume_slider.style.top = "calc(" + (100 - gainToFader(this.channel.getVolume())*100) + "% - " + volume_slider.clientHeight/2 + "px)";
    }
}