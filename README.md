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
yarn ts ./tools/scoreInit.ts
yarn ts ./tools/scoreVision.ts

##	regulation
yarn ts ./tools/spartitoConstructor.ts

```


## Maestro Pipeline

```shell
# save MIDI hashes in midi-hash.yaml
yarn ts ./tools/midiIndexing.ts

yarn ts ./tools/maestroIndexer.ts
```


## Data dependencies of scripts

script | input | output
| - | - | - |
dataInit			| db									| basic.yaml
copyMIDI			| basic.yaml							| origin.midi
audioSplitter		| .mp3, .ogg, .flac						| spleeter.log, .wav
spectrumPlotter		| .wav									| spectrum.log, .wav(delete)
pianoTranscriber	| .wav									| .midi
pageReader			| basic.yaml, .pdf, image-bed			| layout.json
ocr					| basic.yaml, layout.json, image-bed	| omr.yaml, layout.json, image-bed
scoreInit			| basic.yaml, layout.json				| omr.yaml, score.json
scoreVision			| basic.yaml, score.json, image-bed		| omr.yaml, score.json, image-bed(if enabled gauge)
spartitoConstructor	| basic.yaml, score.json				| omr.yaml, .spartito.json, .spartito.midi
spartitoSolver		| basic.yaml, omr.yaml, .spartito.json	| .spartito.midi (in target directory)
