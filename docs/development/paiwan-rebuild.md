# Paiwan rebuild

This branch starts from upstream TraceMemo v2.5.2 commit d6d837e6f6705741000b747af99d75ab120281bd. It is a new implementation, not recovered historical custom source. TraceMemo upstream attribution is retained.

## Development checkpoint 1

Implemented modules (not yet wired to the complete desktop flow): local customer records and confirmed offline notes with correction history; a single no-tools daily summarizer with input-budget and citation checks; pre-read/pre-ASR conversation exclusion; Microsoft personal task/calendar preview-confirm-readback boundary.

Application identity and profile are separate. Automatic legacy-data migration and upstream updating are disabled. Direct customer message sending is disabled. Non-core navigation is hidden. Settings writes are atomic and blocked following a read failure.

Cloud validation: TypeScript node check and three synthetic service-level business flows passed. These are controlled integration flows, not full UI E2E, real WeChat, actual speech recognition, Microsoft login, or Windows acceptance. No real customer data or credentials are used.

## Speech

Reuse the upstream local SenseVoice pipeline, including both sent and received audio. Scope exclusion must apply before reading message/audio or queueing transcription. Recognition failures must be surfaced, not represented as successful full coverage.

The int8 model and tokens total 239,549,735 bytes and are separately downloaded, not embedded here. The original model card labels weights `model-license`; the conversion card does not specify a license. Code MIT licensing is not sufficient evidence for weights redistribution. Weight redistribution/licensing remains unverified. No weights are committed or redistributed by this checkpoint.

References:
- https://huggingface.co/FunAudioLLM/SenseVoiceSmall
- https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17

Windows native audio, DPAPI upgrade, real connector identity and Microsoft integration require separately authorized real-device acceptance. Current cloud execution does not establish those results.
