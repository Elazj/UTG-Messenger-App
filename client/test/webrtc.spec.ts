import { expect, test } from '@playwright/test';

test('two peers negotiate a WebRTC data channel and exchange a message', async ({ page }) => {
  await page.setContent('<!doctype html><title>WebRTC test</title>');
  const result = await page.evaluate(async () => {
    const left = new RTCPeerConnection({ iceServers: [] });
    const right = new RTCPeerConnection({ iceServers: [] });
    const gather = async (peer: RTCPeerConnection) => {
      if (peer.iceGatheringState === 'complete') return;
      await new Promise<void>((resolve) => {
        peer.addEventListener('icegatheringstatechange', () => {
          if (peer.iceGatheringState === 'complete') resolve();
        });
      });
    };
    const received = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('data channel message timed out')), 10000);
      right.ondatachannel = ({ channel }) => {
        channel.onmessage = ({ data }) => { clearTimeout(timeout); resolve(data); };
      };
    });
    const channel = left.createDataChannel('chat');
    const opened = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('data channel did not open')), 10000);
      channel.onopen = () => { clearTimeout(timeout); resolve(); };
    });

    await left.setLocalDescription(await left.createOffer());
    await gather(left);
    await right.setRemoteDescription(left.localDescription!);
    await right.setLocalDescription(await right.createAnswer());
    await gather(right);
    await left.setRemoteDescription(right.localDescription!);
    await opened;
    channel.send('webrtc-roundtrip');
    const message = await received;
    left.close();
    right.close();
    return { state: channel.readyState, message };
  });
  expect(result.message).toBe('webrtc-roundtrip');
});
