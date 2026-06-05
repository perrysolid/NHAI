/**
 * DatalakeFaceAuth — offline on-device face recognition + liveness.
 *
 * Phase 1: render the camera preview screen. Later phases add face detection,
 * the FaceEngine (EdgeFace + MiniFASNet), dual liveness, enroll/verify, and
 * offline→online sync. The auth path stays 100% offline.
 *
 * @format
 */
import React from 'react';
import {SafeAreaView, StatusBar, StyleSheet} from 'react-native';
import CameraScreen from './src/screens/CameraScreen';

function App(): React.JSX.Element {
  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor="#000" />
      <CameraScreen />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#000'},
});

export default App;
