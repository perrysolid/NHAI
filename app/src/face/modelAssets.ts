import type {RecognitionModelId} from '../config';

export const RECOGNITION_ASSETS: Partial<Record<RecognitionModelId, number>> = {
  facenet_512: require('../../assets/models/facenet_512.tflite'),
};

export const LIVENESS_ASSET = require('../../assets/models/minifasnet.tflite');
