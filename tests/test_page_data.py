import json
import struct
import unittest
from pathlib import Path

TRACES = Path(__file__).resolve().parents[1] / 'docs' / 'traces'
UNBROKEN_TIME = 0.4


class PageDataTests(unittest.TestCase):
    """Checks the digitised traces behind the interactive figures against the paper's results."""

    @classmethod
    def setUpClass(cls):
        cls.meta = json.loads((TRACES / 'meta.json').read_text(encoding='utf-8'))

    def traces(self, mode):
        raw = (TRACES / mode['file']).read_bytes()
        n_ch, n_t = len(mode['channels']), mode['n_t']
        self.assertEqual(len(raw), 2 * 2 * n_ch * n_t)
        values = struct.unpack(f'<{len(raw) // 2}h', raw)
        return [[values[(p * n_ch + c) * n_t:(p * n_ch + c + 1) * n_t] for c in range(n_ch)] for p in range(2)]

    def test_montage_fills_the_grid_once(self):
        for key, mode in self.meta['modes'].items():
            cols, rows = mode['grid']
            cells = {(c['col'], c['row']) for c in mode['channels']}
            self.assertEqual(len(cells), cols * rows, key)
            self.assertEqual(len(mode['channels']), cols * rows, key)

    def test_flagged_share_matches_interpolated_channels(self):
        # A channel is interpolated when RANSAC flags it in more than unbroken_time of the epochs.
        for key, mode in self.meta['modes'].items():
            for channel, bits in zip(mode['channels'], mode['flags']['bits']):
                self.assertEqual(len(bits), mode['flags']['rows'])
                share = bits.count('1') / len(bits)
                self.assertEqual(share > UNBROKEN_TIME, channel['bad'], f'{key} channel {channel["name"]}')

    def test_ransac_changes_only_flagged_channels(self):
        for key, mode in self.meta['modes'].items():
            filtered, ransac = self.traces(mode)
            for c, channel in enumerate(mode['channels']):
                largest = max(abs(a - b) for a, b in zip(filtered[c], ransac[c])) / 10
                if channel['bad']:
                    self.assertGreater(largest, 1.0, f'{key} channel {channel["name"]}')
                else:
                    self.assertLessEqual(largest, 0.2, f'{key} channel {channel["name"]}')


if __name__ == '__main__':
    unittest.main()
