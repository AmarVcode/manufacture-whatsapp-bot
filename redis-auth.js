const { createClient } = require('redis');
const { proto, useMultiFileAuthState } = require('@whiskeysockets/baileys');

const REDIS_URL = process.env.REDIS_URL;

let redisClient = null;

async function getRedisClient() {
  if (!REDIS_URL) return null;
  
  if (!redisClient) {
    redisClient = createClient({ url: REDIS_URL });
    redisClient.on('error', (err) => console.warn('Redis Client Error (falling back to file storage)', err));
    try {
      await redisClient.connect();
    } catch (e) {
      console.warn('Failed to connect to Redis (falling back to file storage)', e);
      redisClient = null;
    }
  }
  return redisClient;
}

async function useRedisAuthState(prefix = 'baileys_auth') {
  const client = await getRedisClient();
  
  if (!client) {
    console.log('Using file-based auth storage');
    return await useMultiFileAuthState('baileys_auth_info');
  }

  console.log('Using Redis auth storage');
  
  const saveCredsToRedis = async (creds) => {
    await client.set(`${prefix}:creds`, JSON.stringify(creds));
  };

  const loadCredsFromRedis = async () => {
    const data = await client.get(`${prefix}:creds`);
    return data ? JSON.parse(data) : null;
  };

  const saveKeyToRedis = async (type, id, key) => {
    await client.set(`${prefix}:keys:${type}:${id}`, JSON.stringify(key));
  };

  const loadKeyFromRedis = async (type, id) => {
    const data = await client.get(`${prefix}:keys:${type}:${id}`);
    return data ? JSON.parse(data) : null;
  };

  const creds = await loadCredsFromRedis();

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
            const val = await loadKeyFromRedis(type, id);
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
              await saveKeyToRedis(type, id, val);
            }
          }
        },
        clear: async () => {
          const keys = await client.keys(`${prefix}:*`);
          if (keys.length > 0) {
            await client.del(keys);
          }
        }
      }
    },
    saveCreds: async () => {
      await saveCredsToRedis(state.creds);
    }
  };
}

module.exports = { useRedisAuthState, getRedisClient };
