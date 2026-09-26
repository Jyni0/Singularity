//! Incremental UTF-8 decoder for byte streams (SSE and friends).
//!
//! A streamed response can cut a multi-byte character in half between two
//! chunks. Decoding each chunk with from_utf8_lossy on its own replaced every
//! split character with U+FFFD — Cyrillic text arrived mangled ("кириллица
//! выглядит как мусор"). This decoder keeps the incomplete tail and only ever
//! emits COMPLETE characters; genuinely invalid bytes still degrade to the
//! replacement char instead of poisoning the rest of the stream.

#[derive(Default)]
pub struct StreamDecoder {
    buf: Vec<u8>,
}

impl StreamDecoder {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    /// Feeds the next chunk; returns all text that is complete UTF-8 so far.
    /// An incomplete trailing character is held back until its rest arrives.
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.buf.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.buf) {
                Ok(_) => {
                    // Whole buffer is valid — emit it all.
                    out.push_str(&String::from_utf8_lossy(&self.buf));
                    self.buf.clear();
                    break;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    if valid > 0 {
                        out.push_str(&String::from_utf8_lossy(&self.buf[..valid]));
                        self.buf.drain(..valid);
                    }
                    match e.error_len() {
                        // A genuinely invalid byte sequence: flush it as
                        // replacement chars and keep decoding after it.
                        Some(len) => {
                            out.push_str(&String::from_utf8_lossy(&self.buf[..len]));
                            self.buf.drain(..len);
                        }
                        // Incomplete tail — wait for the next chunk.
                        None => break,
                    }
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::StreamDecoder;

    #[test]
    fn split_cyrillic_survives_chunk_boundary() {
        // "Привет" — each Cyrillic letter is 2 bytes; cut mid-character.
        let full = "Привет, мир!".as_bytes();
        let mut dec = StreamDecoder::new();
        let mut out = String::new();
        // Feed byte-by-byte: the worst-case split.
        for b in full {
            out.push_str(&dec.push(std::slice::from_ref(b)));
        }
        assert_eq!(out, "Привет, мир!");
        assert!(!out.contains('\u{FFFD}'), "no replacement chars");
    }

    #[test]
    fn emoji_split_across_chunks() {
        let full = "done 🎉 ok".as_bytes();
        let mut dec = StreamDecoder::new();
        let split = 6; // inside the 4-byte emoji
        let mut out = dec.push(&full[..split]);
        out.push_str(&dec.push(&full[split..]));
        assert_eq!(out, "done 🎉 ok");
    }

    #[test]
    fn invalid_bytes_degrade_to_replacement() {
        let mut dec = StreamDecoder::new();
        let mut out = dec.push(&[0xff, 0xfe, b'h', b'i']);
        out.push_str(&dec.push(b" there"));
        assert!(out.contains("hi there"));
    }
}
