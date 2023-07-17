# IMSLP Mining


## Prerequisites

Config file in project root direcotry: `config.local.yaml`

+	*pyclients*, the OMR python clients.


## Data Pipeline

```shell
# setup work folders and create base.yaml
yarn ts ./tools/dataInit.ts

# copy midi files
yarn ts ./tools/copyMIDI.ts

# Audio
##	split audio files and remove silent audio
yarn ts ./tools/audioSplitter.ts
python ./spectrumPlotter.py

##	piano audio to MIDI
python ./pianoTranscriber.py

# sheet music
## 	page location
yarn ts ./tools/pageReader.ts

##	vison
yarn ts ./tools/ocr.ts

```
