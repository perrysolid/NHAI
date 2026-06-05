import type {RecognitionModelId} from '../config';

export const RECOGNITION_ASSETS: Partial<Record<RecognitionModelId, number>> = {
  mobilefacenet: require('../../assets/models/mobilefacenet.tflite'),
};

export const LIVENESS_ASSET = require('../../assets/models/minifasnet.tflite');
