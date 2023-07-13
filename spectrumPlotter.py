
import sys
import os
import logging
import numpy as np
import librosa
import piano_transcription_inference as pti

import env



logging.basicConfig(stream=sys.stdout, level=logging.INFO)


def fftWave (filename):
	audio, _ = pti.load_audio(filename, sr=16000, mono=True)
	fft = librosa.stft(audio, n_fft=256)
	db = librosa.amplitude_to_db(np.abs(fft), amin=1e-5)
	db_pad = np.pad(db, ((0, 0), (0, 1024 - db.shape[1] % 1024)), constant_values=-200)
	thumb = db_pad.reshape(db_pad.shape[0], -1, 1024).mean(axis=-1)
	thumb = thumb[:128].reshape(8, 16, -1).max(axis=1)

	mean_db = db.max(axis=-1).mean()

	return thumb, mean_db


GRAYSCALE_CHARS = [' ', '\u2591', '\u2592', '\u2593', '\u2588']


def stringifyThumb (thumb):
	thumb_int = (thumb * 0.0667 + 3).clip(min=0, max=4).astype(np.int8)[::-1]
	text = '\n'.join([''.join([GRAYSCALE_CHARS[pix] for pix in line]) for line in thumb_int])

	return text


def main():
	for root, dirs, files in os.walk("./data"):
		if root.endswith('spleeter'):
			waves = [f for f in files if f.endswith('.wav')]
			if len(waves) == 0:
				continue

			log_path = os.path.join(root, 'spectrum.log')
			if 'spectrum.log' in files:
				continue

			with open(log_path, 'w') as log:
				for file in waves:
					file_path = os.path.join(root, file)
					logging.info('Plotting %s', file_path)
					log.write(f'{file}\n')

					thumb, db = fftWave(file_path)
					logging.info('mean db: %.2f', db)
					log.write(f'mean db: {db}\n')

					text_thumb = stringifyThumb(thumb)
					#print(text_thumb)
					log.write('spectrum:\n')
					log.write(text_thumb)
					log.write('\n\n')


if __name__ == "__main__":
	main()
