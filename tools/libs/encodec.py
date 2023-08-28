
import struct
import torch
from transformers import EncodecModel, AutoProcessor



model = EncodecModel.from_pretrained("facebook/encodec_24khz")
processor = AutoProcessor.from_pretrained("facebook/encodec_24khz")

sampling_rate = processor.sampling_rate


def modelEncode (audio, bandwidth=24):
	with torch.no_grad():
		inputs = processor(raw_audio=audio, sampling_rate=sampling_rate, return_tensors="pt")
		encoder_outputs = model.encode(inputs["input_values"], inputs["padding_mask"], bandwidth=bandwidth)

		return encoder_outputs.audio_codes, encoder_outputs.audio_scales, inputs["padding_mask"]


def modelDecode (codes, scales, mask=None):
	with torch.no_grad():
		return model.decode(codes, scales, mask)[0]


def packInt10 (source: torch.Tensor) -> bytes:
	buf64 = (source.view(-1, 4) * torch.tensor([[1, 2 ** 10, 2 ** 20, 2 ** 30]], dtype=torch.int64)).sum(dim=-1, keepdim=True)
	buf8 = (buf64 >> torch.tensor([0, 8, 16, 24, 32]) % 0x100).type(torch.uint8).flatten()

	return struct.pack('B' * buf8.shape[0], * buf8)


def unpackInt10 (buf: bytes) -> torch.Tensor:
	buf8 = torch.tensor(struct.unpack('B' * len(buf), buf), dtype=torch.int64)
	buf64 = (buf8.view(-1, 5) << torch.tensor([[0, 8, 16, 24, 32]], dtype=torch.int64)).sum(dim=-1, keepdim=True)
	buf10 = (buf64 >> torch.tensor([30, 20, 10, 0], dtype=torch.int64)).flatten() % (2 ** 10)

	return buf10
