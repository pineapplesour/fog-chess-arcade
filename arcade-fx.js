(function (global) {
  "use strict";

  var context = null;
  var masterGain = null;
  var SILENCE = 0.0001;

  function ignoreRejection(promise) {
    if (promise && typeof promise.catch === "function") {
      promise.catch(function () {});
    }
  }

  function resumeSilently(audioContext) {
    try {
      if (audioContext.state === "suspended") {
        ignoreRejection(audioContext.resume());
      }
    } catch (_) {}
  }

  function init() {
    var candidate = null;

    try {
      if (context) {
        resumeSilently(context);
        return;
      }

      var AudioContextClass = global.AudioContext || global.webkitAudioContext;
      if (!AudioContextClass) {
        return;
      }

      candidate = new AudioContextClass();
      var gain = candidate.createGain();
      gain.gain.setValueAtTime(0.5, candidate.currentTime);
      gain.connect(candidate.destination);

      context = candidate;
      masterGain = gain;
      resumeSilently(context);
    } catch (_) {
      context = null;
      masterGain = null;
      if (candidate && typeof candidate.close === "function") {
        try {
          ignoreRejection(candidate.close());
        } catch (_) {}
      }
    }
  }

  function disconnect(nodes) {
    for (var i = 0; i < nodes.length; i += 1) {
      try {
        nodes[i].disconnect();
      } catch (_) {}
    }
  }

  function scheduleSource(source, startAt, stopAt, nodes) {
    source.onended = function () {
      source.onended = null;
      disconnect(nodes);
    };
    source.start(startAt);
    source.stop(stopAt);
  }

  function envelope(startAt, duration, peak, attack) {
    var gain = context.createGain();
    var attackEnd = startAt + Math.min(attack || 0.004, duration * 0.4);

    gain.gain.setValueAtTime(SILENCE, startAt);
    gain.gain.exponentialRampToValueAtTime(peak, attackEnd);
    gain.gain.exponentialRampToValueAtTime(SILENCE, startAt + duration);
    return gain;
  }

  function tone(type, frequency, startAt, duration, volume, endFrequency) {
    var oscillator = context.createOscillator();
    var gain = envelope(startAt, duration, volume, 0.003);

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, startAt);
    if (endFrequency) {
      oscillator.frequency.exponentialRampToValueAtTime(
        endFrequency,
        startAt + duration
      );
    }

    oscillator.connect(gain);
    gain.connect(masterGain);
    scheduleSource(
      oscillator,
      startAt,
      startAt + duration + 0.005,
      [oscillator, gain]
    );
  }

  function noise(startAt, duration, volume, startFrequency, endFrequency, q) {
    var frameCount = Math.max(1, Math.ceil(context.sampleRate * duration));
    var buffer = context.createBuffer(1, frameCount, context.sampleRate);
    var samples = buffer.getChannelData(0);
    for (var i = 0; i < frameCount; i += 1) {
      samples[i] = Math.random() * 2 - 1;
    }

    var source = context.createBufferSource();
    var filter = context.createBiquadFilter();
    var gain = envelope(startAt, duration, volume, 0.01);

    source.buffer = buffer;
    filter.type = "bandpass";
    filter.Q.setValueAtTime(q || 1, startAt);
    filter.frequency.setValueAtTime(startFrequency, startAt);
    filter.frequency.exponentialRampToValueAtTime(
      endFrequency,
      startAt + duration
    );

    source.connect(filter);
    filter.connect(gain);
    gain.connect(masterGain);
    scheduleSource(source, startAt, startAt + duration, [source, filter, gain]);
  }

  function safeEffect(effect) {
    return function () {
      if (!context || !masterGain) {
        return;
      }
      try {
        effect.apply(null, arguments);
      } catch (_) {}
    };
  }

  var move = safeEffect(function () {
    var now = context.currentTime + 0.005;
    tone("triangle", 190, now, 0.055, 0.17, 78);
    noise(now, 0.045, 0.07, 1150, 650, 1.4);
  });

  var capture = safeEffect(function () {
    var now = context.currentTime + 0.005;
    tone("sine", 145, now, 0.13, 0.26, 62);
    tone("triangle", 1350, now + 0.018, 0.13, 0.045, 970);
    tone("sine", 2050, now + 0.024, 0.12, 0.025, 1540);
  });

  var combo = safeEffect(function (n) {
    var level = Number(n);
    if (!Number.isFinite(level) || level < 2) {
      return;
    }

    var now = context.currentTime + 0.005;
    var base = 523.25 * (2 - Math.pow(0.92, level - 2));
    var ratios = level >= 3 ? [1, 1.25, 1.5] : [1, 1.5];

    for (var i = 0; i < ratios.length; i += 1) {
      tone(
        "triangle",
        base * ratios[i],
        now + i * 0.075,
        0.115,
        0.14,
        base * ratios[i] * 1.035
      );
    }
  });

  var tick = safeEffect(function () {
    var now = context.currentTime + 0.005;
    tone("square", 1568, now, 0.042, 0.1, 1320);
  });

  var timeout = safeEffect(function () {
    var now = context.currentTime + 0.005;
    tone("sawtooth", 92, now, 0.52, 0.13, 72);
    tone("square", 97, now, 0.52, 0.08, 76);
  });

  var kingCapture = safeEffect(function () {
    var now = context.currentTime + 0.005;
    var notes = [392, 523.25, 659.25];
    for (var i = 0; i < notes.length; i += 1) {
      tone("sawtooth", notes[i], now + i * 0.11, 0.17, 0.09);
    }
  });

  var win = safeEffect(function () {
    var now = context.currentTime + 0.005;
    var notes = [523.25, 659.25, 783.99, 1046.5];
    var starts = [0, 0.16, 0.32, 0.52];
    var durations = [0.18, 0.18, 0.2, 0.32];
    for (var i = 0; i < notes.length; i += 1) {
      tone("triangle", notes[i], now + starts[i], durations[i], 0.14);
    }
  });

  var lose = safeEffect(function () {
    var now = context.currentTime + 0.005;
    var notes = [392, 329.63, 261.63, 196];
    var starts = [0, 0.17, 0.34, 0.52];
    var durations = [0.19, 0.19, 0.21, 0.34];
    for (var i = 0; i < notes.length; i += 1) {
      tone("triangle", notes[i], now + starts[i], durations[i], 0.13);
    }
  });

  var reveal = safeEffect(function () {
    var now = context.currentTime + 0.005;
    noise(now, 0.42, 0.055, 280, 4200, 0.7);
  });

  try {
    global.ArcadeFX = {
      init: init,
      move: move,
      capture: capture,
      combo: combo,
      tick: tick,
      timeout: timeout,
      kingCapture: kingCapture,
      win: win,
      lose: lose,
      reveal: reveal
    };
  } catch (_) {}
})(window);
