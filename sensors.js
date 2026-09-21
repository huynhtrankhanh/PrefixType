/* Browser-provided device motion/orientation. Values remain in device axes;
 * missing axes are null, never synthesized as zero. */
(function (root) {
  'use strict';
  const number = value => Number.isFinite(value) ? value : null;
  class DeviceRecorder {
    constructor(indicator, record) {
      this.indicator = indicator; this.record = record; this.active = false;
      this.lastSample = -Infinity; this.permission = 'automatic';
      this.permissionTypes = [root.DeviceMotionEvent, root.DeviceOrientationEvent]
        .filter(type => typeof type?.requestPermission === 'function');
      if (this.permissionTypes.length) this.permission = 'prompt';
      this.supported = root.isSecureContext && !!(root.DeviceMotionEvent || root.DeviceOrientationEvent);
      indicator.addEventListener('click', () => this.requestPermission());
      for (const type of ['devicemotion', 'deviceorientation', 'deviceorientationabsolute']) {
        root.addEventListener(type, event => this.sample(event), { passive: true });
      }
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') this.lastSample = -Infinity;
        this.render();
      });
      this.timer = root.setInterval(() => this.render(), 500);
      this.render();
    }
    async requestPermission() {
      if (!this.supported || this.permission === 'requesting') return;
      this.permission = 'requesting'; this.render();
      // Both calls must run in the click's user activation, before awaiting.
      const requests = this.permissionTypes.map(type => {
        try { return Promise.resolve(type === root.DeviceOrientationEvent ? type.requestPermission(true) : type.requestPermission()); }
        catch (error) { return Promise.reject(error); }
      });
      const results = await Promise.allSettled(requests);
      this.permission = results.some(r => r.status === 'fulfilled' && r.value === 'granted') ? 'granted' : 'denied';
      this.render();
    }
    setActive(active) {
      this.active = active; this.lastSample = -Infinity; this.render();
    }
    sample(event) {
      if (!this.active || !this.supported || document.visibilityState !== 'visible') return;
      const sample = { type: event.type === 'devicemotion' ? 'motion' :
        event.type === 'deviceorientationabsolute' ? 'orientationabsolute' : 'orientation',
        timeStamp: number(event.timeStamp),
        screenAngle: number(root.screen.orientation?.angle ?? root.orientation) };
      let values;
      if (sample.type === 'motion') {
        for (const [prefix, vector, axes] of [
          ['acceleration', event.acceleration, ['X', 'Y', 'Z']],
          ['gravity', event.accelerationIncludingGravity, ['X', 'Y', 'Z']],
          ['rotation', event.rotationRate, ['Alpha', 'Beta', 'Gamma']]
        ]) for (const axis of axes) sample[prefix + axis] = number(vector?.[axis.toLowerCase()]);
        values = Object.keys(sample).filter(key => /^(acceleration|gravity|rotation)/.test(key)).map(key => sample[key]);
        sample.interval = number(event.interval);
      } else {
        for (const key of ['alpha', 'beta', 'gamma', 'webkitCompassHeading', 'webkitCompassAccuracy']) sample[key] = number(event[key]);
        sample.absolute = typeof event.absolute === 'boolean' ? event.absolute : null;
        values = [sample.alpha, sample.beta, sample.gamma, sample.webkitCompassHeading];
      }
      if (!values.some(value => value !== null)) return;
      if (this.record(sample)) { this.lastSample = performance.now(); this.render(); }
    }
    render() {
      const recording = this.active && document.visibilityState === 'visible' && performance.now() - this.lastSample < 2000;
      const prompt = this.supported && ['prompt', 'denied'].includes(this.permission);
      const label = recording ? 'Device sensors recording' : this.permission === 'requesting' ? 'Requesting sensor access…' :
        prompt ? (this.permission === 'denied' ? 'Sensor access denied · tap to retry' : 'Enable motion & orientation recording') : '';
      if (this.indicator.textContent === label && this.indicator.dataset.recording === String(recording)) return;
      this.indicator.hidden = !label;
      this.indicator.dataset.recording = String(recording);
      this.indicator.disabled = recording || !prompt;
      this.indicator.textContent = label;
    }
  }
  root.DeviceRecorder = DeviceRecorder;
})(window);
