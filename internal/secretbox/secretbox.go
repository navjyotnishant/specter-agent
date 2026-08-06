// Package secretbox reads and writes Fernet tokens, compatible with Python's
// cryptography library.
//
// WHY THIS IS HAND-ROLLED
// Go has no Fernet implementation in its standard library, and this must be
// byte-compatible with what the Python backend already wrote. Existing
// installations hold credentials encrypted by it; a Go backend that cannot read
// them loses every stored credential — silently, because a failed decrypt reads
// as "not set".
//
// THE FERNET TOKEN FORMAT (spec: github.com/fernet/spec)
//
//	version   1 byte    always 0x80
//	timestamp 8 bytes   big-endian seconds since the epoch
//	IV        16 bytes  AES-CBC initialisation vector
//	ciphertext        AES-128-CBC, PKCS#7 padded
//	HMAC     32 bytes   SHA256 over everything preceding it
//
// The whole thing is base64url-encoded. The 32-byte key is base64url too, and
// splits: first 16 bytes sign, last 16 encrypt. Getting that order backwards
// produces tokens that verify against themselves and nothing else — which a
// round-trip test would happily pass, and is why the tests decrypt a fixture
// produced by real Python instead.
package secretbox

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"time"
)

const (
	versionByte   = 0x80
	keyLen        = 32
	ivLen         = 16
	hmacLen       = 32
	timestampLen  = 8
	minTokenBytes = 1 + timestampLen + ivLen + hmacLen
)

// Box encrypts and decrypts with one Fernet key.
type Box struct {
	signingKey    []byte // first 16 bytes
	encryptionKey []byte // last 16 bytes
}

// New builds a Box from a base64url-encoded 32-byte key — the format Python's
// Fernet.generate_key() produces and writes to secrets/integration_secret.key.
func New(encodedKey string) (*Box, error) {
	key, err := base64.URLEncoding.DecodeString(encodedKey)
	if err != nil {
		// Python writes the padded form; accept the unpadded one too rather
		// than failing on a key someone trimmed by hand.
		key, err = base64.RawURLEncoding.DecodeString(encodedKey)
		if err != nil {
			return nil, fmt.Errorf("key is not valid base64url: %w", err)
		}
	}
	if len(key) != keyLen {
		return nil, fmt.Errorf("key must be %d bytes, got %d", keyLen, len(key))
	}
	return &Box{signingKey: key[:16], encryptionKey: key[16:]}, nil
}

// GenerateKey produces a new key in Python's format.
func GenerateKey() (string, error) {
	key := make([]byte, keyLen)
	if _, err := rand.Read(key); err != nil {
		return "", fmt.Errorf("generating key: %w", err)
	}
	return base64.URLEncoding.EncodeToString(key), nil
}

// Encrypt returns a Fernet token. Empty input stays empty, meaning "not set" —
// the same convention the Python side uses.
func Encrypt(box *Box, plaintext string) (string, error) { return box.Encrypt(plaintext) }

func (b *Box) Encrypt(plaintext string) (string, error) {
	if plaintext == "" {
		return "", nil
	}

	iv := make([]byte, ivLen)
	if _, err := rand.Read(iv); err != nil {
		return "", fmt.Errorf("generating IV: %w", err)
	}

	block, err := aes.NewCipher(b.encryptionKey)
	if err != nil {
		return "", fmt.Errorf("creating cipher: %w", err)
	}

	padded := pkcs7Pad([]byte(plaintext), aes.BlockSize)
	ciphertext := make([]byte, len(padded))
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(ciphertext, padded)

	body := make([]byte, 0, minTokenBytes+len(ciphertext))
	body = append(body, versionByte)
	body = binary.BigEndian.AppendUint64(body, uint64(time.Now().Unix()))
	body = append(body, iv...)
	body = append(body, ciphertext...)

	mac := hmac.New(sha256.New, b.signingKey)
	mac.Write(body)
	body = append(body, mac.Sum(nil)...)

	return base64.URLEncoding.EncodeToString(body), nil
}

// Decrypt reads a Fernet token.
//
// The HMAC is verified BEFORE anything is decrypted. Decrypting first and
// checking after would leak information through padding errors — the classic
// padding-oracle mistake.
func (b *Box) Decrypt(token string) (string, error) {
	if token == "" {
		return "", nil
	}

	raw, err := base64.URLEncoding.DecodeString(token)
	if err != nil {
		raw, err = base64.RawURLEncoding.DecodeString(token)
		if err != nil {
			return "", fmt.Errorf("token is not valid base64url: %w", err)
		}
	}
	if len(raw) < minTokenBytes {
		return "", fmt.Errorf("token is too short to be valid")
	}
	if raw[0] != versionByte {
		return "", fmt.Errorf("unsupported token version %#x", raw[0])
	}

	body, providedMAC := raw[:len(raw)-hmacLen], raw[len(raw)-hmacLen:]

	mac := hmac.New(sha256.New, b.signingKey)
	mac.Write(body)
	// Constant-time: a byte-by-byte comparison leaks how much of a forged MAC
	// was correct, which is enough to construct a valid one.
	if !hmac.Equal(mac.Sum(nil), providedMAC) {
		return "", fmt.Errorf("token failed authentication — wrong key or tampered")
	}

	iv := body[1+timestampLen : 1+timestampLen+ivLen]
	ciphertext := body[1+timestampLen+ivLen:]
	if len(ciphertext) == 0 || len(ciphertext)%aes.BlockSize != 0 {
		return "", fmt.Errorf("ciphertext length is not a multiple of the block size")
	}

	block, err := aes.NewCipher(b.encryptionKey)
	if err != nil {
		return "", fmt.Errorf("creating cipher: %w", err)
	}
	plaintext := make([]byte, len(ciphertext))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(plaintext, ciphertext)

	unpadded, err := pkcs7Unpad(plaintext, aes.BlockSize)
	if err != nil {
		return "", err
	}
	return string(unpadded), nil
}

func pkcs7Pad(data []byte, blockSize int) []byte {
	// Always adds padding, a full block when the data already aligns — without
	// that, unpadding cannot tell padding from data.
	padding := blockSize - len(data)%blockSize
	out := make([]byte, len(data)+padding)
	copy(out, data)
	for i := len(data); i < len(out); i++ {
		out[i] = byte(padding)
	}
	return out
}

func pkcs7Unpad(data []byte, blockSize int) ([]byte, error) {
	if len(data) == 0 || len(data)%blockSize != 0 {
		return nil, fmt.Errorf("invalid padded length")
	}
	padding := int(data[len(data)-1])
	if padding == 0 || padding > blockSize || padding > len(data) {
		return nil, fmt.Errorf("invalid padding")
	}
	for _, b := range data[len(data)-padding:] {
		if int(b) != padding {
			return nil, fmt.Errorf("invalid padding")
		}
	}
	return data[:len(data)-padding], nil
}
