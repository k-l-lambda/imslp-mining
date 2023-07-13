
import sys
import os
import piano_transcription_inference as pti

import env



PTI_NAMES = os.getenv('PTI_NAMES').split(',')


def main():
	transcriptor = pti.PianoTranscription(device=os.getenv('TORCH_DEVICE'))

	try:
		for root, dirs, files in os.walk("./data"):
			if root.endswith('spleeter'):
				waves = [f for f in files if f.endswith('.wav')]
				sources = [f for f in waves if f.replace('.wav', '') in PTI_NAMES]
				for source in sources:
					midi_filename = source.replace('.wav', '.midi')
					if midi_filename in files:
						print('Skipped:', root)
					else:
						print('Transcribing:', root)
						(audio, _) = pti.load_audio(os.path.join(root, source), sr=pti.sample_rate, mono=True)

						midi_path = os.path.join(root, midi_filename)
						transcriptor.transcribe(audio, midi_path)

						os.symlink(os.path.abspath(midi_path), os.path.join(root, '..', midi_filename))
	except:
		print(sys.exc_info())


if __name__ == "__main__":
	main()
