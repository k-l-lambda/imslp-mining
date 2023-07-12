
import sys
import os
import piano_transcription_inference as pti

import env



PTI_NAMES = os.getenv('PTI_NAMES').split(',')


def main():
	transcriptor = pti.PianoTranscription(device=os.getenv('TORCH_DEVICE'))

	for root, dirs, files in os.walk("./data"):
		if root.endswith('spleeter'):
			sources = [f for f in files if f.replace('.wav', '') in PTI_NAMES]
			for source in sources:
				print('Transcribing', root)
				(audio, _) = pti.load_audio(os.path.join(root, source), sr=pti.sample_rate, mono=True)
				transcriptor.transcribe(audio, os.path.join(root, source.replace('.wav', '.midi')))


if __name__ == "__main__":
	main()
