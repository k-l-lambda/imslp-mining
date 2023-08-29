
# convert wav files to rvq format

import sys
import os
import logging
import librosa

import env
from tools.libs.encodec import sampling_rate
from tools.libs.rvqFormat import RVQFile



logging.basicConfig(stream=sys.stdout, level=logging.INFO)


def main():
	n_files = 0

	for root, dirs, files in os.walk('./data'):
		waves = [f for f in files if f.endswith('.wav')]
		if len(waves) == 0:
			continue

		for file in waves:
			file_path = os.path.join(root, file)
			logging.info('Converting: %s', file_path)

			audio, sr = librosa.core.load(file_path, sr=sampling_rate, mono=True)
			rvq = RVQFile.fromAudio(audio, sr)

			target_path = file_path.replace('.wav', '.rvq')
			with open(target_path, 'wb') as file:
				rvq.save(file)

			# delete source wav
			os.remove(file_path)

			n_files += 1

	logging.info('Done, %d files converted.', n_files)


if __name__ == "__main__":
	main()
