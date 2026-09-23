export {};
declare global {
  interface Window {
    SpeechRecognition: any;
    webkitSpeechRecognition: any;
  }
}

let recognition: any = null;
const channel = new URL(location.href).searchParams.get('channel') || '';

function report(event: string, extra: Record<string, unknown> = {}) {
  chrome.runtime.sendMessage({ type: 'ECHO_SPEECH_EVENT', channel, event, ...extra }).catch(() => {});
}

// Initialize SpeechRecognition
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onstart = () => {
    report('start');
  };

  recognition.onresult = (event: any) => {
    let finalTranscript = '';
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) {
        finalTranscript += event.results[i][0].transcript;
      }
    }
    if (finalTranscript) {
      report('result', { text: finalTranscript });
    }
  };

  recognition.onerror = (event: any) => {
    report('error', { error: String(event.error || 'speech error') });
  };

  recognition.onend = () => {
    report('end');
  };
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'ECHO_SPEECH_CONTROL_DELIVER' || message.channel !== channel) return;
  if (message.command === 'start' && recognition) {
    const language = String(message.language || 'en-US');
    if (/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(language)) recognition.lang = language;
    try {
      recognition.start();
    } catch (e) {
      // ignore already started
    }
  } else if (message.command === 'stop' && recognition) {
    recognition.stop();
  }
});
