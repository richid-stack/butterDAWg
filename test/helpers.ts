import { Clock } from "../src/engine/Transport";

/** a clock the test moves by hand */
export class FakeClock implements Clock {
    time = 0;
    now() {
        return this.time;
    }
}
