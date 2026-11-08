globalThis.notesImages = {
  async upload(bridge, note, file) {
    const { uploadId } = await bridge.invoke('image-begin', { id: note.id, revision: note.revision, name: file.name.slice(0, 200), type: file.type, size: file.size });
    try {
      let result;
      for (let offset = 0, index = 0; offset < file.size; offset += 48 * 1024, index++) {
        const bytes = new Uint8Array(await file.slice(offset, offset + 48 * 1024).arrayBuffer());
        let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
        result = await bridge.invoke('image-append', { uploadId, index, data: btoa(binary) });
      }
      if (!result?.complete || !result.note) throw new Error('Incomplete image upload');
      return result.note;
    } catch (error) {
      await bridge.invoke('image-cancel', { uploadId }).catch(() => {});
      throw error;
    }
  },
  async read(bridge, id, imageId) {
    const first = await bridge.invoke('image-chunk', { id, imageId, index: 0 });
    const parts = [];
    for (let index = 0; index < first.chunks; index++) {
      const chunk = index ? await bridge.invoke('image-chunk', { id, imageId, index }) : first;
      parts.push(Uint8Array.from(atob(chunk.data), character => character.charCodeAt(0)));
    }
    return new Blob(parts, { type: first.type });
  },
};
