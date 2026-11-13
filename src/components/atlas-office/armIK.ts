import { Quaternion, Vector3, type Object3D } from "three";

/**
 * Hands on the keyboard and mouse: a two-bone IK applied on top of the playing animation clip. Each frame, after
 * the mixer has posed the skeleton, the upper arm and forearm are turned so the wrist reaches its target, with the
 * elbow bending toward a pole point (out to the side, down and back). `weight` blends between the clip (0) and the
 * IK pose (1), so hands move smoothly onto and off the desk.
 */

export interface HandTargets {
  /** 0 = clip only, 1 = hands fully on the targets. */
  weight: number;
  /** Lean the upper body toward the desk (radians at full weight). */
  lean: number;
  /** Which way the body faces (radians about y, 0 = +z). */
  facing: number;
  left: Vector3;
  right: Vector3;
}

export function handTargets(): HandTargets {
  return { weight: 0, lean: 0, facing: 0, left: new Vector3(), right: new Vector3() };
}

export interface ArmRig {
  spine: Object3D | null;
  left: [Object3D, Object3D, Object3D] | null;
  right: [Object3D, Object3D, Object3D] | null;
}

/** glTF loaders replace spaces in node names with underscores, so look bones up both ways. */
function bone(root: Object3D, name: string): Object3D | null {
  return root.getObjectByName(name) ?? root.getObjectByName(name.replace(/ /g, "_")) ?? null;
}

/** Arm bones of a 3ds Max Biped skeleton (the Rocketbox avatars). */
export function findArmRig(root: Object3D): ArmRig {
  const arm = (side: "L" | "R") => {
    const chain = [`Bip01 ${side} UpperArm`, `Bip01 ${side} Forearm`, `Bip01 ${side} Hand`].map((name) => bone(root, name));
    return chain.every(Boolean) ? (chain as [Object3D, Object3D, Object3D]) : null;
  };
  return { spine: bone(root, "Bip01 Spine1"), left: arm("L"), right: arm("R") };
}

const s = new Vector3();
const e = new Vector3();
const w = new Vector3();
const goal = new Vector3();
const dir = new Vector3();
const bend = new Vector3();
const elbow = new Vector3();
const from = new Vector3();
const to = new Vector3();
const delta = new Quaternion();
const world = new Quaternion();
const parent = new Quaternion();
const identity = new Quaternion();

/** Turns `bone` (in world space) by the rotation taking direction `a` to direction `b`, scaled by `weight`. */
function turn(bone: Object3D, a: Vector3, b: Vector3, weight: number) {
  delta.setFromUnitVectors(a.normalize(), b.normalize());
  // Partial weight: move back toward no rotation. (slerpQuaternions(identity, delta) would overwrite delta first.)
  if (weight < 1) delta.slerp(identity, 1 - weight);
  bone.getWorldQuaternion(world);
  world.premultiply(delta);
  if (bone.parent) {
    bone.parent.getWorldQuaternion(parent);
    world.premultiply(parent.invert());
  }
  bone.quaternion.copy(world);
  bone.updateWorldMatrix(false, true);
}

function solveArm(chain: [Object3D, Object3D, Object3D], target: Vector3, pole: Vector3, weight: number) {
  const [upper, lower, hand] = chain;
  upper.updateWorldMatrix(true, true);
  upper.getWorldPosition(s);
  lower.getWorldPosition(e);
  hand.getWorldPosition(w);
  const a = s.distanceTo(e);
  const b = e.distanceTo(w);
  if (a < 1e-4 || b < 1e-4) return;
  dir.subVectors(target, s);
  const distance = Math.min(Math.max(dir.length(), Math.abs(a - b) + 1e-3), a + b - 1e-3);
  dir.normalize();
  goal.copy(s).addScaledVector(dir, distance);
  // Elbow: in the plane of the shoulder, the target and the pole.
  bend.subVectors(pole, s);
  bend.addScaledVector(dir, -bend.dot(dir));
  if (bend.lengthSq() < 1e-8) return;
  bend.normalize();
  const cos = (a * a + distance * distance - b * b) / (2 * a * distance);
  const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
  elbow.copy(s).addScaledVector(dir, a * cos).addScaledVector(bend, a * sin);
  turn(upper, from.subVectors(e, s), to.subVectors(elbow, s), weight);
  lower.getWorldPosition(e);
  hand.getWorldPosition(w);
  turn(lower, from.subVectors(w, e), to.subVectors(goal, e), weight);
}

const right = new Vector3();
const forward = new Vector3();
const leanAxis = new Quaternion();
const pole = new Vector3();
const DOWN = new Vector3(0, -1, 0);

/**
 * Applies the hand targets (world space) to a character. Call after the animation mixer has updated.
 */
export function applyHands(rig: ArmRig, targets: HandTargets) {
  const weight = targets.weight;
  if (weight <= 0.001) return;
  forward.set(Math.sin(targets.facing), 0, Math.cos(targets.facing));
  // The character's right, for a body facing `forward` with y up.
  right.set(-forward.z, 0, forward.x);
  if (rig.spine && targets.lean) {
    // Lean forward: rotate the spine about the character's right axis (pitching the chest toward the desk).
    leanAxis.setFromAxisAngle(right, -targets.lean * weight);
    rig.spine.getWorldQuaternion(world);
    world.premultiply(leanAxis);
    if (rig.spine.parent) {
      rig.spine.parent.getWorldQuaternion(parent);
      world.premultiply(parent.invert());
    }
    rig.spine.quaternion.copy(world);
    rig.spine.updateWorldMatrix(false, true);
  }
  for (const [chain, target, side] of [
    [rig.left, targets.left, -1],
    [rig.right, targets.right, 1],
  ] as const) {
    if (!chain) continue;
    chain[0].getWorldPosition(pole);
    // Elbows out to the side, down and slightly back.
    pole.addScaledVector(right, side * 0.45).addScaledVector(DOWN, 0.6).addScaledVector(forward, -0.3);
    solveArm(chain, target, pole, weight);
  }
}
