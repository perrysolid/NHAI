/**
 * GuidanceOverlay — live framing feedback for Phase 2.
 *
 * Draws a centered alignment oval and a guidance
 * banner. Purely presentational; the gate decision comes from qualityGates.
 */
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import type {GateResult} from '../camera/types';

const OVAL_COLOR = '#050505';

export default function GuidanceOverlay({
  gate,
}: {
  gate: GateResult;
}): React.JSX.Element {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={styles.ringWrap}>
        <View style={styles.ring} />
      </View>
      <View style={[styles.banner, gate.ready && styles.bannerReady]}>
        <Text style={styles.bannerText}>{gate.guidance}</Text>
      </View>
    </View>
  );
}

const RING = 280;
const styles = StyleSheet.create({
  ringWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: {
    width: RING,
    height: RING * 1.25,
    borderRadius: RING,
    borderColor: OVAL_COLOR,
    borderWidth: 4,
  },
  banner: {
    position: 'absolute',
    bottom: 56,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 22,
  },
  bannerReady: {backgroundColor: 'rgba(34,197,94,0.85)'},
  bannerText: {color: '#fff', fontSize: 15, fontWeight: '600'},
});
