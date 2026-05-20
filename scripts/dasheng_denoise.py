#!/usr/bin/env python3
import argparse
from pathlib import Path

import soundfile as sf
import torch
import torchaudio
from transformers import AutoModel


def db_to_gain(db: float) -> float:
    return 10 ** (db / 20)


def biquad_peaking(audio: torch.Tensor, sr: int, freq: float, q: float, gain_db: float) -> torch.Tensor:
    a = db_to_gain(gain_db)
    w0 = 2 * torch.pi * torch.tensor(freq / sr, dtype=audio.dtype, device=audio.device)
    alpha = torch.sin(w0) / (2 * q)
    cos_w0 = torch.cos(w0)

    b0 = 1 + alpha * a
    b1 = -2 * cos_w0
    b2 = 1 - alpha * a
    a0 = 1 + alpha / a
    a1 = -2 * cos_w0
    a2 = 1 - alpha / a

    return torchaudio.functional.lfilter(
        audio,
        torch.stack([a0, a1, a2]) / a0,
        torch.stack([b0, b1, b2]) / a0,
        clamp=False,
    )


PROFILE_DEFAULTS = {
    # Clear is the best default when the neural output removes noise but hurts words.
    "clear": {"raw_mix": 0.40, "detail_mix": 0.16, "presence_db": 2.0, "air_db": 1.0},
    "balanced": {"raw_mix": 0.30, "detail_mix": 0.10, "presence_db": 2.5, "air_db": 1.3},
    "strong": {"raw_mix": 0.18, "detail_mix": 0.05, "presence_db": 3.0, "air_db": 1.5},
}


def rms(audio: torch.Tensor) -> torch.Tensor:
    return torch.sqrt(torch.mean(audio.square()).clamp(min=1e-12))


def post_process_for_intelligibility(
    original: torch.Tensor,
    enhanced: torch.Tensor,
    sr: int,
    raw_mix: float | None,
    profile: str,
) -> torch.Tensor:
    settings = PROFILE_DEFAULTS[profile]
    original = original.to(enhanced.device, dtype=enhanced.dtype)
    sample_count = min(original.shape[-1], enhanced.shape[-1])
    original = original[..., :sample_count]
    enhanced = enhanced[..., :sample_count]
    raw_mix = settings["raw_mix"] if raw_mix is None else raw_mix
    raw_mix = max(0.0, min(0.65, raw_mix))
    mixed = enhanced * (1 - raw_mix) + original * raw_mix

    # Neural denoisers can smear consonants, especially for speech/languages they
    # were not tuned around. Add only the high-detail part of the original back.
    detail = biquad_peaking(original, sr, 2800.0, 0.8, 5.5) - original
    detail = biquad_peaking(detail, sr, 5200.0, 1.0, 3.0)
    mixed = mixed + detail * settings["detail_mix"]

    # Keep the voice body, but avoid the muffled/telephone effect.
    mixed = biquad_peaking(mixed, sr, 220.0, 0.9, -1.0)
    mixed = biquad_peaking(mixed, sr, 1200.0, 1.0, 1.2)
    mixed = biquad_peaking(mixed, sr, 3000.0, 1.0, settings["presence_db"])
    mixed = biquad_peaking(mixed, sr, 5600.0, 1.1, settings["air_db"])

    # Match the original loudness gently so the enhanced file is easy to compare.
    target = rms(original) * 0.95
    current = rms(mixed)
    if current > 1e-6:
        mixed = mixed * (target / current).clamp(0.5, 2.0)

    peak = mixed.abs().max().clamp(min=1e-6)
    if peak > 0.98:
        mixed = mixed / peak * 0.98
    return mixed


def choose_device(name: str) -> torch.device:
    if name != "auto":
        return torch.device(name)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def main() -> None:
    parser = argparse.ArgumentParser(description="Run Dasheng denoiser on a WAV file.")
    parser.add_argument("input", type=Path, help="Input noisy WAV file.")
    parser.add_argument("-o", "--output", type=Path, help="Output enhanced WAV file.")
    parser.add_argument("--model-dir", type=Path, default=Path("dasheng-denoiser"), help="Local Dasheng model directory.")
    parser.add_argument("--device", default="auto", help="auto, cuda, cpu, or mps.")
    parser.add_argument(
        "--profile",
        choices=sorted(PROFILE_DEFAULTS),
        default="clear",
        help="Post-processing profile: clear preserves words most, strong removes more noise.",
    )
    parser.add_argument(
        "--raw-mix",
        type=float,
        default=None,
        help="Override amount of original audio to blend back for speech clarity.",
    )
    parser.add_argument("--no-post", action="store_true", help="Disable clarity blend/EQ post-processing.")
    args = parser.parse_args()

    input_path = args.input
    output_path = args.output or input_path.with_name(f"{input_path.stem}-dasheng.wav")
    model_dir = args.model_dir
    device = choose_device(args.device)

    if not input_path.exists():
        raise SystemExit(f"Input file not found: {input_path}")
    if not model_dir.exists():
        raise SystemExit(f"Model directory not found: {model_dir}")

    data, sr = sf.read(str(input_path), always_2d=True, dtype="float32")
    audio = torch.from_numpy(data.T)
    if audio.shape[0] > 1:
        audio = audio.mean(dim=0, keepdim=True)
    if sr != 16000:
        audio = torchaudio.functional.resample(audio, sr, 16000)
        sr = 16000

    print(f"Loading Dasheng from {model_dir} on {device}...")
    model = AutoModel.from_pretrained(
        str(model_dir),
        trust_remote_code=True,
        local_files_only=True,
    ).to(device)
    model.eval()

    original_audio = audio.clone()
    audio = audio.to(device)
    with torch.no_grad():
        if device.type == "cuda":
            with torch.autocast(device_type="cuda"):
                enhanced = model(audio)
        else:
            enhanced = model(audio)

    if not args.no_post:
        enhanced = post_process_for_intelligibility(original_audio.to(device), enhanced, sr, args.raw_mix, args.profile)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    enhanced_np = enhanced.detach().cpu().squeeze(0).numpy()
    sf.write(str(output_path), enhanced_np, sr)
    print(f"Saved enhanced audio: {output_path}")


if __name__ == "__main__":
    main()
