import { applyExifOrientation } from "./exif-orientation.js";
import { assertBase64ImageWithinEncodedLimit, validateImageForDecode } from "./image-decode-safety.js";
import { loadPhoton } from "./photon.js";

/**
 * Convert image to PNG format for terminal display.
 * Kitty graphics protocol requires PNG format (f=100).
 */
export async function convertToPng(
	base64Data: string,
	mimeType: string,
): Promise<{ data: string; mimeType: string } | null> {
	assertBase64ImageWithinEncodedLimit(base64Data);
	const bytes = new Uint8Array(Buffer.from(base64Data, "base64"));
	if (!validateImageForDecode(bytes)) {
		return null;
	}

	// Already PNG, no conversion needed
	if (mimeType === "image/png") {
		return { data: base64Data, mimeType };
	}

	const photon = await loadPhoton();
	if (!photon) {
		// Photon not available, can't convert
		return null;
	}

	let image: ReturnType<typeof photon.PhotonImage.new_from_byteslice> | undefined;
	try {
		image = photon.PhotonImage.new_from_byteslice(bytes);
		const orientedImage = applyExifOrientation(photon, image, bytes);
		if (orientedImage !== image) {
			image.free();
			image = orientedImage;
		}
		const pngBuffer = image.get_bytes();
		return {
			data: Buffer.from(pngBuffer).toString("base64"),
			mimeType: "image/png",
		};
	} catch {
		// Conversion failed
		return null;
	} finally {
		image?.free();
	}
}
