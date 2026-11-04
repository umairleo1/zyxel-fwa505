import test from 'node:test';
import assert from 'node:assert/strict';
import { isSecretKey, maskSecrets, MASK } from '../../src/router/secrets.js';
import { publicCollectorState } from '../../src/status.js';

test('secret-looking keys are masked', () => {
  for (const k of [
    'X_ZYXEL_ProvisioningKey',
    'ProvisioningCode',
    'PrivateKey',
    'privkey',
    'ClientCert',
    'Certificate',
    'AccessToken',
    'WEPKey',
    'Key',
    'NewPIN',
    'PIN_Code',
    'X_ZYXEL_PUK',
    'ConnectionRequestPassword',
  ]) {
    assert.ok(isSecretKey(k), k);
  }
});

test('flags, counters and references are not masked', () => {
  for (const k of [
    'X_ZYXEL_AvailableInterfaceKey',
    'X_ZYXEL_ProvisioningCodeIntf',
    'RekeyingInterval',
    'CheckCert',
    'KeyLength',
    'TokenExpiry',
    'FAXPassThrough',
    'ModemPassThrough',
    'USIM_PIN_RemainingAttempts',
    'X_ZYXEL_PIN_STATE',
    'Ping_Interval',
    'SSID',
  ]) {
    assert.ok(!isSecretKey(k), k);
  }
});

test('numeric secrets are masked, booleans and empties kept', () => {
  assert.deepEqual(maskSecrets({ PIN: 1234, X_ZYXEL_AutoUnlockPIN: true, Password: '', RekeyingInterval: 3600 }), {
    PIN: MASK,
    X_ZYXEL_AutoUnlockPIN: true,
    Password: '',
    RekeyingInterval: 3600,
  });
});

test('keep option leaves identifiers visible', () => {
  const keep = /serial/i;
  assert.deepEqual(maskSecrets({ SerialKey: 'S1', ProvisioningCode: 'abc' }, { keep }), { SerialKey: 'S1', ProvisioningCode: MASK });
});

test('status payload masks router secrets but keeps IMEI/IMSI/ICCID/serial', () => {
  const state = {
    phase: 'ok',
    router: {
      device: { SerialNumber: 'S123', ProvisioningCode: 'acs-secret', ModelName: 'FWA505' },
      cellwan: { IMEI: '350000000000000', IMSI: '234000000000000', USIM_ICCID: '8944000000000000000', PIN: '0000' },
    },
  };
  const out = publicCollectorState(state);
  assert.equal(out.router.device.SerialNumber, 'S123');
  assert.equal(out.router.device.ProvisioningCode, MASK);
  assert.equal(out.router.device.ModelName, 'FWA505');
  assert.equal(out.router.cellwan.IMEI, '350000000000000');
  assert.equal(out.router.cellwan.IMSI, '234000000000000');
  assert.equal(out.router.cellwan.USIM_ICCID, '8944000000000000000');
  assert.equal(out.router.cellwan.PIN, MASK);
  assert.equal(state.router.device.ProvisioningCode, 'acs-secret'); // not mutated
  assert.equal(publicCollectorState({ phase: 'starting' }).router, undefined);
});

test('names that always hold a secret stay masked despite look-alike words', () => {
  for (const k of ['PasswordVerify', 'SourcePassword', 'X_ZYXEL_CheckPSK', 'PrivateKeyFormat']) assert.equal(isSecretKey(k), true, k);
});
