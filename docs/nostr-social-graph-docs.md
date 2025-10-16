Nostr Social Graph

A TypeScript library for building and querying social graphs from Nostr follow events.
Features

    Build social graphs from Nostr follow events
    Query followed users, followers, and follow distances
    Change social graph root user with efficient distance recalculation
    Low memory consumption
    Efficient binary serialization (55% smaller than JSON)
    Pre-crawled datasets
    Server for maintaining and serving the up-to-date social graph, for quick initialization in web apps

See tests for detailed usage examples:
```
import { describe, it, expect, beforeEach } from 'vitest';
import { SocialGraph } from '../src/SocialGraph';
import { NostrEvent } from '../src/utils';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pubKeys = {
    adam: "020f2d21ae09bf35fcdfb65decf1478b846f5f728ab30c5eaabcd6d081a81c3e",
    fiatjaf: "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d",
    snowden: "84dee6e676e5bb67b4ad4e042cf70cbd8681155db535942fcc6a0533858a7240",
    sirius: "4523be58d395b1b196a9b8c82b038b6895cb02b683d0c253a955068dba1facd0",
}

const SOCIAL_GRAPH_FILE = path.join(__dirname, '../data/socialGraph.json');

describe('SocialGraph', () => {
  it('should initialize with root user', () => {
    const graph = new SocialGraph(pubKeys.adam);
    expect(graph.getFollowDistance(pubKeys.adam)).toBe(0);
  });

  it('should handle follow events', () => {
    const graph = new SocialGraph(pubKeys.adam);
    const event: NostrEvent = {
      created_at: 1000,
      content: '',
      tags: [['p', pubKeys.fiatjaf]],
      kind: 3,
      pubkey: pubKeys.adam,
      id: 'event1',
      sig: 'signature',
    };
    graph.handleEvent(event, true);
    expect(graph.isFollowing(pubKeys.adam, pubKeys.fiatjaf)).toBe(true);
  });

  it('should update follow distances correctly', () => {
    const graph = new SocialGraph(pubKeys.adam);
    const event1: NostrEvent = {
      created_at: 1000,
      content: '',
      tags: [['p', pubKeys.fiatjaf]],
      kind: 3,
      pubkey: pubKeys.adam,
      id: 'event1',
      sig: 'signature',
    };
    const event2: NostrEvent = {
      created_at: 2000,
      content: '',
      tags: [['p', pubKeys.snowden]],
      kind: 3,
      pubkey: pubKeys.fiatjaf,
      id: 'event2',
      sig: 'signature',
    };
    graph.handleEvent(event1, true);
    graph.handleEvent(event2, true);
    expect(graph.getFollowDistance(pubKeys.snowden)).toBe(2);
  });

  it('should serialize and deserialize correctly', async () => {
    const graph = new SocialGraph(pubKeys.adam);
    const event1: NostrEvent = {
      created_at: 1000,
      content: '',
      tags: [['p', pubKeys.fiatjaf]],
      kind: 3,
      pubkey: pubKeys.adam,
      id: 'event1',
      sig: 'signature',
    };
    const event2: NostrEvent = {
      created_at: 2000,
      content: '',
      tags: [['p', pubKeys.snowden]],
      kind: 3,
      pubkey: pubKeys.fiatjaf,
      id: 'event2',
      sig: 'signature',
    };
    graph.handleEvent(event1, true);
    graph.handleEvent(event2, true);

    expect(graph.getFollowDistance(pubKeys.adam)).toBe(0)
    expect(graph.getFollowDistance(pubKeys.fiatjaf)).toBe(1);
    expect(graph.getFollowDistance(pubKeys.snowden)).toBe(2);
    expect(graph.isFollowing(pubKeys.adam, pubKeys.fiatjaf)).toBe(true);
    expect(graph.isFollowing(pubKeys.fiatjaf, pubKeys.snowden)).toBe(true);

    const binary = await graph.toBinary();
    const newGraph = await SocialGraph.fromBinary(pubKeys.adam, binary);

    expect(newGraph.getFollowDistance(pubKeys.adam)).toBe(0)
    expect(newGraph.getFollowDistance(pubKeys.fiatjaf)).toBe(1);
    expect(newGraph.getFollowDistance(pubKeys.snowden)).toBe(2);
    expect(newGraph.isFollowing(pubKeys.adam, pubKeys.fiatjaf)).toBe(true);
    expect(newGraph.isFollowing(pubKeys.fiatjaf, pubKeys.snowden)).toBe(true);
  });

  it('should update follow distances when root is changed', async () => {
    const graph = new SocialGraph(pubKeys.adam);
    const event1: NostrEvent = {
      created_at: 1000,
      content: '',
      tags: [['p', pubKeys.fiatjaf]],
      kind: 3,
      pubkey: pubKeys.adam,
      id: 'event1',
      sig: 'signature',
    };
    const event2: NostrEvent = {
      created_at: 2000,
      content: '',
      tags: [['p', pubKeys.snowden]],
      kind: 3,
      pubkey: pubKeys.fiatjaf,
      id: 'event2',
      sig: 'signature',
    };
    graph.handleEvent(event1, true);
    graph.handleEvent(event2, true);

    // Initial follow distances
    expect(graph.getFollowDistance(pubKeys.adam)).toBe(0);
    expect(graph.getFollowDistance(pubKeys.fiatjaf)).toBe(1);
    expect(graph.getFollowDistance(pubKeys.snowden)).toBe(2);

    await graph.setRoot(pubKeys.snowden);

    // Snowden doesn't follow anyone.
    expect(graph.getFollowDistance(pubKeys.snowden)).toBe(0);
    expect(graph.getFollowDistance(pubKeys.fiatjaf)).toBe(1000);
    expect(graph.getFollowDistance(pubKeys.adam)).toBe(1000);

    await graph.setRoot(pubKeys.fiatjaf);

    // Fiatjaf follows Snowden.
    expect(graph.getFollowDistance(pubKeys.snowden)).toBe(1);
    expect(graph.getFollowDistance(pubKeys.fiatjaf)).toBe(0);
    expect(graph.getFollowDistance(pubKeys.adam)).toBe(1000);

    await graph.setRoot(pubKeys.adam)
    // Initial follow distances
    expect(graph.getFollowDistance(pubKeys.adam)).toBe(0);
    expect(graph.getFollowDistance(pubKeys.fiatjaf)).toBe(1);
    expect(graph.getFollowDistance(pubKeys.snowden)).toBe(2);
  });



  /* commented out slow test, social graph file too big
  it('should validate the structure of the crawled social graph', () => {
    if (!fs.existsSync(SOCIAL_GRAPH_FILE)) {
      throw new Error('Social graph file does not exist');
    }

    const jsonData = fs.readFileSync(SOCIAL_GRAPH_FILE, 'utf-8');
    const parsedData = JSON.parse(jsonData);

    // Check followLists structure
    expect(Array.isArray(parsedData.followLists)).toBe(true);
    parsedData.followLists.forEach((followList: any) => {
      expect(Array.isArray(followList)).toBe(true);
      expect(followList.length).toBe(3); // pubkey, followed users, list timestamp
      expect(typeof followList[0]).toBe('number');
      const followedUsers = followList[1]
      expect(Array.isArray(followedUsers)).toBe(true);
      followedUsers.forEach((id: any) => {
        expect(typeof id).toBe('number');
      });
      const listTimestamp = followList[2]
      expect(typeof listTimestamp).toBe('number');
    });

    // Check uniqueIds structure
    expect(Array.isArray(parsedData.uniqueIds)).toBe(true);
    parsedData.uniqueIds.forEach((uniqueId: any) => {
      expect(Array.isArray(uniqueId)).toBe(true);
      expect(uniqueId.length).toBe(2);
      expect(typeof uniqueId[0]).toBe('string');
      expect(typeof uniqueId[1]).toBe('number');
    });

    // Attempt to load the graph to ensure it's valid
    const graph = new SocialGraph('rootPubKey', parsedData);
    expect(graph).toBeInstanceOf(SocialGraph);
  });
  */

  it('should utilize existing follow lists for new users', async () => {
    const graph = new SocialGraph(pubKeys.adam);
    const event1: NostrEvent = {
      created_at: 1000,
      content: '',
      tags: [['p', pubKeys.fiatjaf]],
      kind: 3,
      pubkey: pubKeys.adam,
      id: 'event1',
      sig: 'signature',
    };
    const event2: NostrEvent = {
      created_at: 2000,
      content: '',
      tags: [['p', pubKeys.snowden]],
      kind: 3,
      pubkey: pubKeys.fiatjaf,
      id: 'event2',
      sig: 'signature',
    };
    graph.handleEvent(event1, true);
    graph.handleEvent(event2, true);

    expect(graph.getFollowDistance(pubKeys.adam)).toBe(0);
    expect(graph.getFollowDistance(pubKeys.fiatjaf)).toBe(1);
    expect(graph.getFollowDistance(pubKeys.snowden)).toBe(2);
    expect(graph.isFollowing(pubKeys.adam, pubKeys.fiatjaf)).toBe(true);
    expect(graph.isFollowing(pubKeys.fiatjaf, pubKeys.snowden)).toBe(true);

    const binary = await graph.toBinary();
    const newGraph = await SocialGraph.fromBinary(pubKeys.sirius, binary);
    await newGraph.recalculateFollowDistances();

    // Check initial state of newGraph
    expect(newGraph.isFollowing(pubKeys.adam, pubKeys.fiatjaf)).toBe(true);
    expect(newGraph.isFollowing(pubKeys.fiatjaf, pubKeys.snowden)).toBe(true);
    expect(newGraph.getFollowDistance(pubKeys.sirius)).toBe(0);
    expect(newGraph.getFollowDistance(pubKeys.adam)).toBe(1000);
    expect(newGraph.getFollowDistance(pubKeys.fiatjaf)).toBe(1000);
    expect(newGraph.getFollowDistance(pubKeys.snowden)).toBe(1000);

    const event3: NostrEvent = {
      created_at: 3000,
      content: '',
      tags: [['p', pubKeys.adam]],
      kind: 3,
      pubkey: pubKeys.sirius,
      id: 'event3',
      sig: 'signature',
    };
    newGraph.handleEvent(event3, true);

    // should we do this automatically on some condition?
    await newGraph.recalculateFollowDistances();

    // Check updated state of newGraph
    expect(newGraph.isFollowing(pubKeys.sirius, pubKeys.adam)).toBe(true);
    expect(newGraph.isFollowing(pubKeys.adam, pubKeys.fiatjaf)).toBe(true);
    expect(newGraph.isFollowing(pubKeys.fiatjaf, pubKeys.snowden)).toBe(true);
    expect(newGraph.getFollowDistance(pubKeys.sirius)).toBe(0);
    expect(newGraph.getFollowDistance(pubKeys.adam)).toBe(1);
    expect(newGraph.getFollowDistance(pubKeys.fiatjaf)).toBe(2);
    expect(newGraph.getFollowDistance(pubKeys.snowden)).toBe(3);
  });

  it('should handle mute and unmute events correctly', () => {
    const graph = new SocialGraph(pubKeys.adam);
    const muteEvent: NostrEvent = {
      created_at: 1000,
      content: '',
      tags: [['p', pubKeys.fiatjaf]],
      kind: 10000,
      pubkey: pubKeys.adam,
      id: 'muteEvent1',
      sig: 'signature',
    };
    graph.handleEvent(muteEvent, true);

    // Test muting
    expect(graph.getMutedByUser(pubKeys.adam)).toContain(pubKeys.fiatjaf);
    expect(graph.getUserMutedBy(pubKeys.fiatjaf)).toContain(pubKeys.adam);

    // Unmute fiatjaf
    const unmuteEvent: NostrEvent = {
      created_at: 2000,
      content: '',
      tags: [],
      kind: 10000,
      pubkey: pubKeys.adam,
      id: 'unmuteEvent1',
      sig: 'signature',
    };
    graph.handleEvent(unmuteEvent, true);

    // Test unmuting
    expect(graph.getMutedByUser(pubKeys.adam)).not.toContain(pubKeys.fiatjaf);
    expect(graph.getUserMutedBy(pubKeys.fiatjaf)).not.toContain(pubKeys.adam);
  });

  it('should preserve mute list during serialization and deserialization', async () => {
    const graph = new SocialGraph(pubKeys.adam);
    const muteEvent: NostrEvent = {
      created_at: 1000,
      content: '',
      tags: [['p', pubKeys.fiatjaf]],
      kind: 10000,
      pubkey: pubKeys.adam,
      id: 'muteEvent1',
      sig: 'signature',
    };
    graph.handleEvent(muteEvent, true);

    // Ensure fiatjaf is muted by adam
    expect(graph.getMutedByUser(pubKeys.adam)).toContain(pubKeys.fiatjaf);

    // Serialize the graph
    const binary = await graph.toBinary();

    // Create a new graph from the binary data
    const newGraph = await SocialGraph.fromBinary(pubKeys.adam, binary);

    // Ensure the mute list is preserved
    expect(newGraph.getMutedByUser(pubKeys.adam)).toContain(pubKeys.fiatjaf);
  });

  describe('budget parameter serialization', () => {
    let graph: SocialGraph;

    beforeEach(async () => {
      // Create a test graph with multiple users and relationships
      graph = new SocialGraph(pubKeys.adam);
      
      // Add some follow relationships
      const followEvent1: NostrEvent = {
        created_at: 1000,
        content: '',
        tags: [['p', pubKeys.fiatjaf], ['p', pubKeys.snowden]],
        kind: 3,
        pubkey: pubKeys.adam,
        id: 'follow1',
        sig: 'sig1',
      };
      
      const followEvent2: NostrEvent = {
        created_at: 1001,
        content: '',
        tags: [['p', pubKeys.sirius]],
        kind: 3,
        pubkey: pubKeys.fiatjaf,
        id: 'follow2',
        sig: 'sig2',
      };

      // Add some mute relationships
      const muteEvent: NostrEvent = {
        created_at: 1002,
        content: '',
        tags: [['p', pubKeys.snowden]],
        kind: 10000,
        pubkey: pubKeys.adam,
        id: 'mute1',
        sig: 'sig3',
      };

      graph.handleEvent(followEvent1, true);
      graph.handleEvent(followEvent2, true);
      graph.handleEvent(muteEvent, true);
      
      await graph.recalculateFollowDistances();
    });



    it('should respect maxNodes parameter in binary serialization', async () => {
      // Test with maxNodes = 2
      let totalBytesLimited = 0;
      for await (const chunk of graph.toBinaryChunks(2)) {
        totalBytesLimited += chunk.length;
      }
      
      // Test with maxNodes = 10
      let totalBytesMore = 0;
      for await (const chunk of graph.toBinaryChunks(10)) {
        totalBytesMore += chunk.length;
      }
      
      expect(totalBytesLimited).toBeLessThan(totalBytesMore);
    });

    it('should respect maxEdges parameter in binary serialization', async () => {
      // Test with maxEdges = 1
      let totalBytesLimited = 0;
      for await (const chunk of graph.toBinaryChunks(undefined, 1)) {
        totalBytesLimited += chunk.length;
      }
      
      // Test with maxEdges = 10
      let totalBytesMore = 0;
      for await (const chunk of graph.toBinaryChunks(undefined, 10)) {
        totalBytesMore += chunk.length;
      }
      
      expect(totalBytesLimited).toBeLessThan(totalBytesMore);
    });

    it('should respect maxDistance parameter in binary serialization', async () => {
      // Test with maxDistance = 0
      let totalBytesDistance0 = 0;
      for await (const chunk of graph.toBinaryChunks(undefined, undefined, 0)) {
        totalBytesDistance0 += chunk.length;
      }
      
      // Test with maxDistance = 1
      let totalBytesDistance1 = 0;
      for await (const chunk of graph.toBinaryChunks(undefined, undefined, 1)) {
        totalBytesDistance1 += chunk.length;
      }
      
      expect(totalBytesDistance0).toBeLessThan(totalBytesDistance1);
    });

    it('should respect maxEdgesPerNode parameter in binary serialization', async () => {
      // Test with maxEdgesPerNode = 1
      let totalBytesLimited = 0;
      for await (const chunk of graph.toBinaryChunks(undefined, undefined, undefined, 1)) {
        totalBytesLimited += chunk.length;
      }
      
      // Test with maxEdgesPerNode = 10
      let totalBytesMore = 0;
      for await (const chunk of graph.toBinaryChunks(undefined, undefined, undefined, 10)) {
        totalBytesMore += chunk.length;
      }
      
      expect(totalBytesLimited).toBeLessThan(totalBytesMore);
    });

    it('should work with combined budget parameters', async () => {
      // Test with multiple parameters combined
      let totalBytes = 0;
      for await (const chunk of graph.toBinaryChunks(3, 2, 1, 1)) {
        totalBytes += chunk.length;
      }
      
      // Should produce a small, valid binary
      expect(totalBytes).toBeGreaterThan(0);
      expect(totalBytes).toBeLessThan(1000); // Should be quite small with these limits
    });



    it('should produce deserializable binary with budget parameters', async () => {
      // Create binary with budget parameters
      const binaryData = await graph.toBinary(5, 3, 1, 2);
      
      // Should be able to deserialize it
      const { fromBinary } = await import('../src/SocialGraphBinary');
      const reconstructedGraph = await fromBinary(pubKeys.adam, binaryData);
      
      expect(reconstructedGraph.getRoot()).toBe(pubKeys.adam);
      expect(reconstructedGraph.size().users).toBeGreaterThan(0);
    });

    it('should handle edge case: maxNodes = 1 (only root)', async () => {
      let totalBytes = 0;
      for await (const chunk of graph.toBinaryChunks(1)) {
        totalBytes += chunk.length;
      }
      
      // Should still produce valid output with just the root user
      expect(totalBytes).toBeGreaterThan(0);
      expect(totalBytes).toBeLessThan(100); // Should be very small
    });



    it('should handle edge case: maxEdgesPerNode = 0', async () => {
      let totalBytes = 0;
      for await (const chunk of graph.toBinaryChunks(undefined, undefined, undefined, 0)) {
        totalBytes += chunk.length;
      }
      
      // Should produce minimal output with no edges per node
      expect(totalBytes).toBeGreaterThan(0);
      expect(totalBytes).toBeLessThan(200); // Should be quite small
    });
  });
});
```
