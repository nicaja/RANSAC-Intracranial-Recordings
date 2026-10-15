"""Compare filtered epochs and RANSAC using the paper's parameter table.

Accepts already preprocessed MNE epochs with a reviewed electrode montage.
This helper does not recreate the original datasets or preprocessing choices.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import mne
import numpy as np
from autoreject import Ransac

PRESETS = {
    'default': {'n_resample': 50, 'min_channels': .25, 'min_corr': .75, 'unbroken_time': .4},
    'epidural-paper': {'n_resample': 7, 'min_channels': .125, 'min_corr': .85, 'unbroken_time': .4},
}

def validate_epochs(epochs):
    if not len(epochs):
        raise ValueError('At least one epoch is required.')
    if any(kind != 'eeg' for kind in epochs.get_channel_types()):
        raise ValueError('Select the intended recording channels and explicitly set their MNE type to eeg before comparison.')
    locations = np.array([ch['loc'][:3] for ch in epochs.info['chs']])
    if not np.isfinite(locations).all() or np.any(np.linalg.norm(locations, axis=1) == 0):
        raise ValueError('A reviewed montage with finite non-zero electrode coordinates is required.')
    if not np.isfinite(epochs.get_data()).all():
        raise ValueError('Epochs contain non-finite samples.')

def signal_metrics(epochs):
    data = epochs.get_data()
    return {'sd_uV': float(np.std(data) * 1e6), 'variance_uV2': float(np.var(data) * 1e12)}

def compare(epochs, preset='default', *, seed=0, n_jobs=1):
    validate_epochs(epochs)
    params = dict(PRESETS[preset])
    detector = Ransac(**params, random_state=seed, n_jobs=n_jobs, verbose=False)
    corrected = detector.fit_transform(epochs.copy())
    after_detector = Ransac(**params, random_state=seed, n_jobs=n_jobs, verbose=False)
    after_detector.fit(corrected)
    report = {
        'parameters': params, 'random_seed': seed,
        'epochs': len(epochs), 'channels': len(epochs.ch_names),
        'sampling_frequency_hz': epochs.info['sfreq'],
        'detected_bad_channels': list(detector.bad_chs_),
        'filtered': {**signal_metrics(epochs), 'reconstruction_correlation': float(np.mean(detector.corr_))},
        'ransac': {**signal_metrics(corrected), 'reconstruction_correlation': float(np.mean(after_detector.corr_))},
        'correlation_definition': 'Mean observed-to-reconstructed channel correlation from a RANSAC fit; not a direct measure of signal truth.',
        'software': {'mne': mne.__version__},
    }
    return corrected, report

def plot_comparison(original, corrected, output):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    with plt.style.context('dark_background'):
        fig, axes = plt.subplots(1, 2, figsize=(12, 4), sharex=True, sharey=True)
        fig.patch.set_facecolor('#0d1117')
        for ax, epochs, title in zip(axes, (original, corrected), ('Filtered', 'Filtered + RANSAC')):
            ax.set_facecolor('#0d1117')
            ax.plot(epochs.times, epochs.get_data().mean(axis=0).T * 1e6, linewidth=.6, alpha=.8)
            ax.set(title=title, xlabel='Time (s)')
            ax.axvline(0, color='#aab3c2', linewidth=.6, linestyle='--')
        axes[0].set_ylabel('Amplitude (µV)')
        fig.tight_layout()
        fig.savefig(output, dpi=160)
        plt.close(fig)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('epochs', type=Path, help='Preprocessed -epo.fif file; no filtering or rescaling is applied here.')
    parser.add_argument('--preset', choices=PRESETS, default='default')
    parser.add_argument('--seed', type=int, default=0)
    parser.add_argument('--n-jobs', type=int, default=1)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    epochs = mne.read_epochs(args.epochs, preload=True)
    corrected, report = compare(epochs, args.preset, seed=args.seed, n_jobs=args.n_jobs)
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / 'comparison.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    plot_comparison(epochs, corrected, args.output / 'comparison.png')

if __name__ == '__main__':
    main()
