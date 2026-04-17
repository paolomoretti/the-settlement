/**
 * Base component class
 * Components hold data, no logic
 */

import { Entity } from './Entity';

export abstract class Component {
  entity?: Entity;
}
