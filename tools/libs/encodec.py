
import os
import struct
import torch
from transformers import EncodecModel, AutoProcessor



ENCODEC_PRETRAINED = os.getenv('ENCODEC_PRETRAINED')
ENCODEC_BANDWIDTH = int(os.getenv('ENCODEC_BANDWIDTH'))

model = EncodecModel.from_pretrained(ENCODEC_PRETRAINED)
processor = AutoProcessor.from_pretrained(ENCODEC_PRETRAINED)

sampling_rate = processor.sampling_rate


def modelEncode (audio, bandwidth=ENCODEC_BANDWIDTH):
	with torch.no_grad():
		inputs = processor(raw_audio=audio, sampling_rate=sampling_rate, return_tensors='pt')
		encoder_outputs = model.encode(inputs['input_values'], inputs['padding_mask'], bandwidth=bandwidth)

		return encoder_outputs.audio_codes, encoder_outputs.audio_scales, inputs['padding_mask']


def modelDecode (codes, scales, mask=None):
	with torch.no_grad():
		return model.decode(codes, scales, mask)[0]


def packInt10 (source: torch.Tensor) -> bytes:
	buf64 = (source.view(-1, 4) << torch.tensor([[0, 10, 20, 30]], dtype=torch.int64)).sum(dim=-1, keepdim=True)
	buf8 = (buf64 >> torch.tensor([0, 8, 16, 24, 32]) % 0x100).type(torch.uint8).flatten()

	return struct.pack('B' * buf8.shape[0], * buf8)


def unpackInt10 (buf: bytes, n_codebook) -> torch.Tensor:
	buf8 = torch.tensor(struct.unpack('B' * len(buf), buf), dtype=torch.int64)
	buf64 = (buf8.view(-1, 5) << torch.tensor([[0, 8, 16, 24, 32]], dtype=torch.int64)).sum(dim=-1, keepdim=True)
	buf10 = (buf64 >> torch.tensor([0, 10, 20, 30], dtype=torch.int64)).flatten() % (2 ** 10)

	return buf10.view(1, 1, n_codebook, -1)
