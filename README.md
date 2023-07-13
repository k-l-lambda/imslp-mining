# IMSLP Mining

## Data Pipeline

```shell
# setup work folders and create base.yaml
yarn ts ./tools/dataInit.ts

# split audio files and remove silent audio
yarn ts ./tools/audioSplitter.ts
python ./spectrumPlotter.py

# piano audio to MIDI
python ./pianoTranscriber.py
```