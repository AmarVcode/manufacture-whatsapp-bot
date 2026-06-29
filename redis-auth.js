const { createClient } = require('redis');
const { proto } = require('@whiskeysockets/baileys');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

let redisClient = null;

async function getRedisClient() {
  if (!redisClient) {
    redisClient = createClient({ url: REDIS_URL });
    redisClient.on('error', (err) => console.error('Redis Client Error', err));
    await redisClient.connect();
  }
  return redisClient;
}

async function useRedisAuthState(prefix = 'baileys_auth') {
  const client = await getRedisClient();

  const saveCreds = async (creds) => {
    await client.set(`${prefix}:creds`, JSON.stringify(creds));
  };

  const loadCreds = async () => {
    const data = await client.get(`${prefix}:creds`);
    return data ? JSON.parse(data) : null;
  };

  const saveKey = async (type, id, key) => {
    await client.set(`${prefix}:keys:${type}:${id}`, JSON.stringify(key));
  };

  const loadKey = async (type, id) => {
    const data = await client.get(`${prefix}:keys:${type}:${id}`);
    return data ? JSON.parse(data) : null;
  };

  const removeKey = async (type, id) => {
    await client.del(`${prefix}:keys:${type}:${id}`);
  };

  const clearAll = async () => {
    const keys = await client.keys(`${prefix}:*`);
    if (keys.length > 0) {
      await client.del(keys);
    }
  };

  const creds = await loadCreds();

  return {
    state: {
      creds: creds || {
        noiseKey: undefined,
        signedIdentityKey: undefined,
        signedPreKey: undefined,
        registrationId: undefined,
        advSecretKey: undefined,
        nextPreKeyId: 1,
        firstUnuploadedPreKeyId: 1,
        accountSettings: undefined,
        accountSyncCounter: undefined,
        deviceId: undefined,
        phoneId: undefined,
        identityId: undefined,
        registered: undefined,
        pairedAccount: undefined,
        lastPropHash: undefined,
        routingInfo: undefined,
        platform: undefined,
        fbToken: undefined,
        fbDeviceId: undefined,
        fbAndroidDeviceId: undefined,
        fbLoginSecret: undefined,
        me: undefined,
        account: undefined
      },
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            const val = await loadKey(type, id);
            if (val) {
              data[id] = type === 'app-state-sync-key' ? proto.Message.AppStateSyncKeyData.decode(Buffer.from(val.data, 'base64')) : val;
            }
          }
          return data;
        },
        set: async (data) => {
          for (const type in data) {
            for (const id in data[type]) {
              let val = data[type][id];
              if (type === 'app-state-sync-key') {
                val = { data: proto.Message.AppStateSyncKeyData.encode(val).finish().toString('base64') };
              }
              await saveKey(type, id, val);
            }
          }
        },
        clear: async () => await clearAll()
      }
    },
    saveCreds: async () => {
      await saveCreds(state.creds);
    }
  };
}

module.exports = { useRedisAuthState, getRedisClient };
