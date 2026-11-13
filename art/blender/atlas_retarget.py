"""
Shared retargeting for ATLAS characters: bakes Universal Animation Library clips (UE-style skeleton, T-pose) onto
another T-posed humanoid skeleton, given a bone map.

Each mapped target bone gets the source bone's world-space rotation change from rest:
    R_target(t) = R_source(t) * R_source_rest^-1 * R_target_rest
Unmapped target bones (twist, share, face bones) keep their rest pose relative to their parent. The root bone's
movement (bob, sitting down) is copied, scaled by the ratio of hip heights.

Usage (exec this file, then call):
    baked = bake_clips(src_armature, dst_armature, actions_by_name, CLIPS, bone_map, dst_root, scene)
"""

import bpy
from mathutils import Matrix

UAL_FINGERS = (("thumb", "Thumb"), ("index", "Index"), ("middle", "Middle"), ("ring", "Ring"), ("pinky", "Pinky"))


def mixamo_map():
    """UAL bone -> Mixamo-style bone (Avaturn, Mixamo characters)."""
    bones = {"pelvis": "Hips", "spine_01": "Spine", "spine_02": "Spine1", "spine_03": "Spine2", "neck_01": "Neck",
             "Head": "Head"}
    for s, side in (("l", "Left"), ("r", "Right")):
        bones.update({
            f"clavicle_{s}": f"{side}Shoulder", f"upperarm_{s}": f"{side}Arm", f"lowerarm_{s}": f"{side}ForeArm",
            f"hand_{s}": f"{side}Hand", f"thigh_{s}": f"{side}UpLeg", f"calf_{s}": f"{side}Leg",
            f"foot_{s}": f"{side}Foot", f"ball_{s}": f"{side}ToeBase",
        })
        for finger, name in UAL_FINGERS:
            for k in (1, 2, 3):
                bones[f"{finger}_0{k}_{s}"] = f"{side}Hand{name}{k}"
    return bones


def character_creator_map():
    """UAL bone -> Reallusion Character Creator / ActorCore bone (CC_Base_*)."""
    bones = {"pelvis": "CC_Base_Hip", "spine_01": "CC_Base_Waist", "spine_02": "CC_Base_Spine01",
             "spine_03": "CC_Base_Spine02", "neck_01": "CC_Base_NeckTwist01", "Head": "CC_Base_Head"}
    cc_fingers = {"thumb": "Thumb", "index": "Index", "middle": "Mid", "ring": "Ring", "pinky": "Pinky"}
    for s, side in (("l", "L"), ("r", "R")):
        bones.update({
            f"clavicle_{s}": f"CC_Base_{side}_Clavicle", f"upperarm_{s}": f"CC_Base_{side}_Upperarm",
            f"lowerarm_{s}": f"CC_Base_{side}_Forearm", f"hand_{s}": f"CC_Base_{side}_Hand",
            f"thigh_{s}": f"CC_Base_{side}_Thigh", f"calf_{s}": f"CC_Base_{side}_Calf",
            f"foot_{s}": f"CC_Base_{side}_Foot", f"ball_{s}": f"CC_Base_{side}_ToeBase",
        })
        for finger, name in cc_fingers.items():
            for k in (1, 2, 3):
                bones[f"{finger}_0{k}_{s}"] = f"CC_Base_{side}_{name}{k}"
    return bones


def biped_map():
    """UAL bone -> 3ds Max Biped bone (Microsoft Rocketbox avatars: "Bip01 L UpperArm", fingers Finger0-4 with
    segments "", "1", "2", e.g. index = Finger1, Finger11, Finger12)."""
    bones = {"pelvis": "Bip01 Pelvis", "spine_01": "Bip01 Spine", "spine_02": "Bip01 Spine1",
             "spine_03": "Bip01 Spine2", "neck_01": "Bip01 Neck", "Head": "Bip01 Head"}
    biped_fingers = {"thumb": 0, "index": 1, "middle": 2, "ring": 3, "pinky": 4}
    for s, side in (("l", "L"), ("r", "R")):
        bones.update({
            f"clavicle_{s}": f"Bip01 {side} Clavicle", f"upperarm_{s}": f"Bip01 {side} UpperArm",
            f"lowerarm_{s}": f"Bip01 {side} Forearm", f"hand_{s}": f"Bip01 {side} Hand",
            f"thigh_{s}": f"Bip01 {side} Thigh", f"calf_{s}": f"Bip01 {side} Calf",
            f"foot_{s}": f"Bip01 {side} Foot", f"ball_{s}": f"Bip01 {side} Toe0",
        })
        for finger, n in biped_fingers.items():
            for k, segment in ((1, ""), (2, "1"), (3, "2")):
                bones[f"{finger}_0{k}_{s}"] = f"Bip01 {side} Finger{n}{segment}"
    return bones


# Joints used to compare limb directions between the two rest poses (bone -> next joint along the limb).
LIMB_NEXT = {}
for _s in ("l", "r"):
    LIMB_NEXT.update({f"clavicle_{_s}": f"upperarm_{_s}", f"upperarm_{_s}": f"lowerarm_{_s}",
                      f"lowerarm_{_s}": f"hand_{_s}", f"hand_{_s}": f"middle_01_{_s}",
                      f"thigh_{_s}": f"calf_{_s}", f"calf_{_s}": f"foot_{_s}"})


def resolve_map(bone_map, arm):
    """Matches map targets to the armature's real bone names, tolerating prefixes and numeric suffixes that
    exporters add (e.g. Sketchfab's "mixamorig:LeftArm_09" for "LeftArm")."""
    import re

    def key(name):
        name = name.split(":")[-1]
        return re.sub(r"_\d+$", "", name).lower()

    real = {key(b.name): b.name for b in arm.data.bones}
    return {s: real[key(d)] for s, d in bone_map.items() if key(d) in real}


def world_rest(arm):
    mw = arm.matrix_world
    return {b.name: mw @ b.matrix_local for b in arm.data.bones}


def _parent_chain_order(arm):
    order, seen = [], set()

    def visit(bone):
        if bone.name in seen:
            return
        if bone.parent:
            visit(bone.parent)
        seen.add(bone.name)
        order.append(bone.name)

    for bone in arm.data.bones:
        visit(bone)
    return order


def retarget(src, dst, action, scene, bone_map, dst_root, src_root="pelvis", name=None):
    src.animation_data_create()
    src.animation_data.action = action
    if hasattr(src.animation_data, "action_slot") and action.slots:
        src.animation_data.action_slot = action.slots[0]
    src_rest, dst_rest = world_rest(src), world_rest(dst)
    dst_inv_world = dst.matrix_world.inverted()
    pairs = [(s, d) for s, d in bone_map.items() if s in src.data.bones and d in dst.data.bones]
    mapped = {d: s for s, d in pairs}
    scale = dst_rest[dst_root].translation.z / src_rest[src_root].translation.z
    corrections = {d: src_rest[s].to_quaternion().inverted() for s, d in pairs}
    dst_rest_rot = {d: dst_rest[d].to_quaternion() for _, d in pairs}
    # If the target's rest pose differs from the source's (A-pose vs T-pose), first swing each limb bone so it
    # points where the source's does at rest; otherwise every clip would be offset by the pose difference.
    for s, d in pairs:
        nxt = LIMB_NEXT.get(s)
        if nxt not in bone_map or nxt not in src.data.bones or bone_map[nxt] not in dst.data.bones:
            continue
        src_dir = (src_rest[nxt].translation - src_rest[s].translation).normalized()
        dst_dir = (dst_rest[bone_map[nxt]].translation - dst_rest[d].translation).normalized()
        if src_dir.angle(dst_dir) > 0.03:  # ~2 degrees
            dst_rest_rot[d] = dst_dir.rotation_difference(src_dir) @ dst_rest_rot[d]
    order = _parent_chain_order(dst)

    baked = bpy.data.actions.new(name or action.name.split(".")[0])
    dst.animation_data_create()
    dst.animation_data.action = baked
    for pb in dst.pose.bones:
        pb.rotation_mode = "QUATERNION"
    start, end = int(action.frame_range[0]), int(action.frame_range[1])
    for frame in range(start, end + 1):
        scene.frame_set(frame)
        src_world = {s: src.matrix_world @ src.pose.bones[s].matrix for s, _ in pairs}
        pose_world = {}
        for bone_name in order:
            bone = dst.data.bones[bone_name]
            parent = bone.parent
            if bone_name in mapped:
                rot = src_world[mapped[bone_name]].to_quaternion() @ corrections[bone_name] @ dst_rest_rot[bone_name]
            elif parent:
                rel = dst_rest[parent.name].inverted() @ dst_rest[bone_name]
                rot = (pose_world[parent.name] @ rel).to_quaternion()
            else:
                rot = dst_rest[bone_name].to_quaternion()
            if bone_name == dst_root:
                head = dst_rest[bone_name].translation + (
                    src_world[src_root].translation - src_rest[src_root].translation) * scale
            elif parent:
                head = (pose_world[parent.name] @ dst_rest[parent.name].inverted() @ dst_rest[bone_name]).translation
            else:
                head = dst_rest[bone_name].translation
            pose_world[bone_name] = Matrix.Translation(head) @ rot.to_matrix().to_4x4()
        for bone_name in order:
            bone = dst.data.bones[bone_name]
            pb = dst.pose.bones[bone_name]
            arm_pose = dst_inv_world @ pose_world[bone_name]
            if bone.parent:
                parent_arm = dst_inv_world @ pose_world[bone.parent.name]
                rel = bone.parent.matrix_local.inverted() @ bone.matrix_local
                local = rel.inverted() @ parent_arm.inverted() @ arm_pose
            else:
                local = bone.matrix_local.inverted() @ arm_pose
            loc, rot, _ = local.decompose()
            pb.rotation_quaternion = rot
            pb.keyframe_insert("rotation_quaternion", frame=frame, group=bone_name)
            if bone_name == dst_root:
                pb.location = loc
                pb.keyframe_insert("location", frame=frame, group=bone_name)
    dst.animation_data.action = None
    for pb in dst.pose.bones:
        pb.matrix_basis.identity()
    return baked


def load_ual(path):
    """Imports the animation library into a scratch scene. Returns (scene, armature, {clip name: action})."""
    scratch = bpy.data.scenes.new("UAL_scratch")
    window = bpy.context.window
    previous = window.scene
    window.scene = scratch
    before_objects, before_actions = set(bpy.data.objects), set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=path)
    objects = [o for o in bpy.data.objects if o not in before_objects]
    for obj in objects:
        if obj.type != "ARMATURE":
            bpy.data.objects.remove(obj, do_unlink=True)
    armature = next(o for o in scratch.objects if o.type == "ARMATURE")
    actions = {a.name.split(".")[0]: a for a in bpy.data.actions if a not in before_actions}
    window.scene = previous
    return scratch, armature, actions


def drop_ual(scratch, actions):
    for obj in list(scratch.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    bpy.data.scenes.remove(scratch)
    for action in actions.values():
        if action.users == 0:
            bpy.data.actions.remove(action)


def bake_clips(dst, dst_root, bone_map, clips, ual_path, suffix=""):
    """Bakes `clips` onto `dst` and stores each as a muted NLA track named after the clip (glTF animation name)."""
    bone_map = resolve_map(bone_map, dst)
    dst_root = bone_map.get("pelvis", dst_root)
    scratch, src, actions = load_ual(ual_path)
    home = bpy.context.window.scene
    scratch.collection.objects.link(dst)
    bpy.context.window.scene = scratch
    baked = []
    for clip in clips:
        if clip in actions:
            baked.append((clip, retarget(src, dst, actions[clip], scratch, bone_map, dst_root, name=clip + suffix)))
    scratch.collection.objects.unlink(dst)
    bpy.context.window.scene = home
    drop_ual(scratch, actions)
    dst.animation_data_create()
    for track in list(dst.animation_data.nla_tracks):
        dst.animation_data.nla_tracks.remove(track)
    for clip, action in baked:
        track = dst.animation_data.nla_tracks.new()
        track.name = clip
        track.strips.new(clip, int(action.frame_range[0]), action)
        track.mute = True
    return [clip for clip, _ in baked]
