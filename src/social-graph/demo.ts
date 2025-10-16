#!/usr/bin/env bun
/**
 * Demo script for Social Graph Integration
 * 
 * This script demonstrates the usage of the SocialGraphManager class
 * with the pre-computed social graph binary file.
 */

import { SocialGraphManager } from './SocialGraphManager.js';
import { config } from '../config/environment.js';

// Test pubkeys (real Nostr pubkeys)
const testPubkeys = {
    adam: '020f2d21ae09bf35fcdfb65decf1478b846f5f728ab30c5eaabcd6d081a81c3e',
    fiatjaf: '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d',
    snowden: '84dee6e676e5bb67b4ad4e042cf70cbd8681155db535942fcc6a0533858a7240',
    sirius: '4523be58d395b1b196a9b8c82b038b6895cb02b683d0c253a955068dba1facd0',
    unknown: '0000000000000000000000000000000000000000000000000000000000000000',
};

async function main() {
    console.log('🚀 Social Graph Integration Demo');
    console.log('================================');
    
    // Initialize the social graph manager
    console.log(`📂 Loading social graph from: ${config.GRAPH_BINARY_PATH}`);
    console.log(`👤 Using root pubkey: ${config.DEFAULT_SOURCE_PUBKEY}`);
    
    const manager = new SocialGraphManager({
        rootPubkey: config.DEFAULT_SOURCE_PUBKEY,
        graphBinaryPath: config.GRAPH_BINARY_PATH,
        autoSave: false
    });
    
    try {
        // Initialize the manager
        await manager.initialize();
        console.log('✅ Social graph initialized successfully!');
        
        // Get graph statistics
        const stats = manager.getGraphStatistics();
        console.log(`\n📊 Graph Statistics:`);
        console.log(`   Users: ${stats.users.toLocaleString()}`);
        console.log(`   Edges: ${stats.edges.toLocaleString()}`);
        console.log(`   Root: ${stats.rootPubkey.slice(0, 8)}...`);
        
        // Test distance queries
        console.log(`\n🔍 Distance Queries (from root):`);
        for (const [name, pubkey] of Object.entries(testPubkeys)) {
            const distance = manager.getFollowDistance(pubkey);
            if (distance < 1000) {
                console.log(`   ${name}: ${distance} hops`);
            } else {
                console.log(`   ${name}: Not reachable`);
            }
        }
        
        // Test distance between two pubkeys
        console.log(`\n🔍 Distance Between Users:`);
        const distanceAdamToFiatjaf = await manager.getDistanceBetween(
            testPubkeys.adam, 
            testPubkeys.fiatjaf
        );
        console.log(`   Adam → Fiatjaf: ${distanceAdamToFiatjaf} hops`);
        
        // Test following relationships
        console.log(`\n🤝 Following Relationships:`);
        const adamFollowsFiatjaf = manager.isFollowing(testPubkeys.adam, testPubkeys.fiatjaf);
        const isReciprocal = manager.isReciprocal(testPubkeys.adam, testPubkeys.fiatjaf);
        console.log(`   Adam follows Fiatjaf: ${adamFollowsFiatjaf}`);
        console.log(`   Mutual follow: ${isReciprocal}`);
        
        // Test graph membership
        console.log(`\n👥 Graph Membership:`);
        for (const [name, pubkey] of Object.entries(testPubkeys)) {
            const inGraph = manager.isInGraph(pubkey);
            console.log(`   ${name}: ${inGraph ? 'In graph' : 'Not in graph'}`);
        }
        
        // Test root switching
        console.log(`\n🔄 Root Switching Demo:`);
        console.log(`   Current root: ${manager.getCurrentRoot().slice(0, 8)}...`);
        
        await manager.switchRoot(testPubkeys.adam);
        console.log(`   Switched to: Adam`);
        
        const distanceFromAdam = manager.getFollowDistance(testPubkeys.fiatjaf);
        console.log(`   Distance from Adam to Fiatjaf: ${distanceFromAdam} hops`);
        
        // Switch back to original root
        await manager.switchRoot(config.DEFAULT_SOURCE_PUBKEY);
        console.log(`   Switched back to original root`);
        
        // Performance test
        console.log(`\n⚡ Performance Test:`);
        const iterations = 1000;
        const startTime = performance.now();
        
        for (let i = 0; i < iterations; i++) {
            manager.getFollowDistance(testPubkeys.adam);
        }
        
        const endTime = performance.now();
        const avgTime = (endTime - startTime) / iterations;
        const queriesPerSecond = 1000 / avgTime;
        
        console.log(`   ${iterations} distance queries in ${(endTime - startTime).toFixed(2)}ms`);
        console.log(`   Average time per query: ${avgTime.toFixed(4)}ms`);
        console.log(`   Queries per second: ${queriesPerSecond.toFixed(0)}`);
        
        // Test mute functionality
        console.log(`\n🔇 Mute Functionality:`);
        const mutedByAdam = manager.getMutedByUser(testPubkeys.adam);
        const adamMutedBy = manager.getUserMutedBy(testPubkeys.adam);
        
        console.log(`   Users muted by Adam: ${mutedByAdam.length}`);
        console.log(`   Users who muted Adam: ${adamMutedBy.length}`);
        
        console.log(`\n🎉 Demo completed successfully!`);
        
    } catch (error) {
        console.error('❌ Error during demo:', error);
        
        if (error instanceof Error) {
            console.error(`   Message: ${error.message}`);
            console.error(`   Stack: ${error.stack}`);
        }
        
        process.exit(1);
    } finally {
        // Clean up
        await manager.cleanup();
        console.log('\n🧹 Cleanup completed.');
    }
}

// Run the demo
if (import.meta.main) {
    main().catch(console.error);
}