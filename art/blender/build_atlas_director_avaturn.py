"""
The Director from the user's own Avaturn avatar (Downloaded-Models/characters/director/NewCEO.glb, Mixamo-style skeleton), animated
with Universal Animation Library clips (Quaternius, CC0, UE-style skeleton) retargeted in Blender.

Retargeting: both skeletons are in a T-pose at rest, so each target bone gets the source bone's world-space
rotation change from rest:  R_target = R_source(t) * R_source_rest^-1 * R_target_rest. Positions follow from the
target's own bone lengths (forward kinematics), plus the hips' movement scaled by leg length.

Run in Blender:
    exec(open(r"C:\\Users\\Strikeout\\Projects\\atlas\\art\\blender\\build_atlas_director_avaturn.py").read())
Writes public/models/atlas/director.glb (replacing the Quaternius-based Director).
"""

import os

import bpy
from mathutils import Matrix

import os
PROJECT = os.environ.get("ATLAS_PROJECT", r"C:\Users\Strikeout\Projects\atlas")
AVATAR = os.path.join(PROJECT, "Downloaded-Models", "characters", "director", "NewCEO.glb")
UAL_GLB = os.path.join(PROJECT, "Downloaded-Models", "animations", "Universal Animation Library[Standard]",
                       "Unreal-Godot", "UAL1_Standard.glb")
GLB_OUT = os.path.join(PROJECT, "public", "models", "atlas", "director.glb")
SCENE = "ATLAS_Director"
CLIPS = ["Idle_Loop", "Walk_Loop", "Jog_Fwd_Loop", "Sprint_Loop", "Idle_Talking_Loop", "Sitting_Enter",
         "Sitting_Idle_Loop", "Sitting_Talking_Loop", "Sitting_Exit", "Interact", "Walk_Formal_Loop", "Dance_Loop"]
TEXTURE_SIZE = 1024

SIDES = {"l": "Left", "r": "Right"}
BONE_MAP = {"pelvis": "Hips", "spine_01": "Spine", "spine_02": "Spine1", "spine_03": "Spine2", "neck_01": "Neck",
            "Head": "Head"}
for s, side in SIDES.items():
    BONE_MAP.update({
        f"clavicle_{s}": f"{side}Shoulder", f"upperarm_{s}": f"{side}Arm", f"lowerarm_{s}": f"{side}ForeArm",
        f"hand_{s}": f"{side}Hand", f"thigh_{s}": f"{side}UpLeg", f"calf_{s}": f"{side}Leg",
        f"foot_{s}": f"{side}Foot", f"ball_{s}": f"{side}ToeBase",
    })
    for finger, name in (("thumb", "Thumb"), ("index", "Index"), ("middle", "Middle"), ("ring", "Ring"),
                         ("pinky", "Pinky")):
        for k in (1, 2, 3):
            BONE_MAP[f"{finger}_0{k}_{s}"] = f"{side}Hand{name}{k}"


def fresh_scene():
    old = bpy.data.scenes.get(SCENE)
    if old:
        for obj in list(old.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.scenes.remove(old)
    for name in ("ATLAS_NewCEO", "UAL_scratch"):
        stale = bpy.data.scenes.get(name)
        if stale:
            for obj in list(stale.objects):
                bpy.data.objects.remove(obj, do_unlink=True)
            bpy.data.scenes.remove(stale)
    scene = bpy.data.scenes.new(SCENE)
    bpy.context.window.scene = scene
    for action in list(bpy.data.actions):  # clips left over from earlier Director builds
        if action.users == 0:
            bpy.data.actions.remove(action)
    return scene


def import_into(scene, path):
    bpy.context.window.scene = scene
    before_objects, before_actions = set(bpy.data.objects), set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=path)
    objects = [o for o in bpy.data.objects if o not in before_objects]
    actions = [a for a in bpy.data.actions if a not in before_actions]
    return objects, actions


def world_rest(arm):
    mw = arm.matrix_world
    return {b.name: mw @ b.matrix_local for b in arm.data.bones}


def retarget(src, dst, action, scene):
    """Bakes `action` (on the source armature) onto a new action for the target armature."""
    src.animation_data.action = action
    if hasattr(src.animation_data, "action_slot") and action.slots:
        src.animation_data.action_slot = action.slots[0]
    src_rest, dst_rest = world_rest(src), world_rest(dst)
    dst_inv_world = dst.matrix_world.inverted()
    pairs = [(s, d) for s, d in BONE_MAP.items() if s in src.data.bones and d in dst.data.bones]
    # Hips travel is scaled by the ratio of hip heights.
    scale = (dst_rest["Hips"].translation.z / src_rest["pelvis"].translation.z)
    corrections = {d: src_rest[s].to_quaternion().inverted() for s, d in pairs}
    dst_rest_rot = {d: dst_rest[d].to_quaternion() for _, d in pairs}
    order = [b.name for b in dst.data.bones]  # parents come before children
    mapped = {d: s for s, d in pairs}

    baked = bpy.data.actions.new(action.name.split(".")[0] + "_ceo")
    dst.animation_data_create()
    dst.animation_data.action = baked
    start, end = int(action.frame_range[0]), int(action.frame_range[1])
    for frame in range(start, end + 1):
        scene.frame_set(frame)
        src_world = {s: src.matrix_world @ src.pose.bones[s].matrix for s, _ in pairs}
        pose_world = {}
        for name in order:
            bone = dst.data.bones[name]
            if name in mapped:
                s = mapped[name]
                rot = src_world[s].to_quaternion() @ corrections[name] @ dst_rest_rot[name]
            else:
                parent_rest = dst_rest[bone.parent.name] if bone.parent else Matrix()
                parent_pose = pose_world.get(bone.parent.name, parent_rest) if bone.parent else Matrix()
                rot = (parent_pose @ parent_rest.inverted() @ dst_rest[name]).to_quaternion()
            if bone.parent:
                parent_rest = dst_rest[bone.parent.name]
                head = (pose_world[bone.parent.name] @ parent_rest.inverted() @ dst_rest[name]).translation
            elif name == "Hips":
                src_hips = src_world["pelvis"].translation
                src_hips_rest = src_rest["pelvis"].translation
                head = dst_rest[name].translation + (src_hips - src_hips_rest) * scale
            else:
                head = dst_rest[name].translation
            pose_world[name] = Matrix.Translation(head) @ rot.to_matrix().to_4x4()
        # Local (basis) transforms straight from the armature-space poses, parents first.
        for name in order:
            bone = dst.data.bones[name]
            pb = dst.pose.bones[name]
            arm_pose = dst_inv_world @ pose_world[name]
            if bone.parent:
                parent_arm = dst_inv_world @ pose_world[bone.parent.name]
                local = (bone.parent.matrix_local.inverted() @ bone.matrix_local).inverted() @ parent_arm.inverted() @ arm_pose
            else:
                local = bone.matrix_local.inverted() @ arm_pose
            pb.matrix_basis = local
            pb.rotation_mode = "QUATERNION"
            pb.keyframe_insert("rotation_quaternion", frame=frame, group=name)
            if name == "Hips":
                pb.keyframe_insert("location", frame=frame, group=name)
    dst.animation_data.action = None
    return baked


def game_ready_textures(objects):
    for obj in objects:
        for mat in obj.data.materials:
            if not mat or not mat.use_nodes:
                continue
            for node in mat.node_tree.nodes:
                img = getattr(node, "image", None)
                if img is None or img.size[0] == 0:
                    continue
                if max(img.size) > TEXTURE_SIZE:
                    w, h = img.size
                    k = TEXTURE_SIZE / max(w, h)
                    img.scale(int(w * k), int(h * k))
                img.pack()


def build():
    scene = fresh_scene()
    avatar_objects, avatar_actions = import_into(scene, AVATAR)
    for action in avatar_actions:  # the sample clip baked into the Avaturn export
        bpy.data.actions.remove(action)
    rig = next(o for o in avatar_objects if o.type == "ARMATURE")
    rig.name = "Director_Rig"
    if rig.animation_data:
        rig.animation_data.action = None
    for pb in rig.pose.bones:
        pb.matrix_basis.identity()
    for obj in avatar_objects:  # helper sphere some exports carry along; only the rig's meshes are the avatar
        if obj.type == "MESH" and obj.parent is not rig:
            bpy.data.objects.remove(obj, do_unlink=True)
    meshes = [o for o in scene.objects if o.type == "MESH" and o.parent is rig]
    for obj in meshes:
        obj.name = "Director_" + obj.name.replace("avaturn_", "")

    scratch = bpy.data.scenes.new("UAL_scratch")
    ual_objects, ual_actions = import_into(scratch, UAL_GLB)
    src = next(o for o in ual_objects if o.type == "ARMATURE")
    for obj in ual_objects:
        if obj.type == "MESH":
            bpy.data.objects.remove(obj, do_unlink=True)
    by_name = {a.name.split(".")[0]: a for a in ual_actions}

    # Bake in the scratch scene (where the source armature lives), with the target linked there too.
    scratch.collection.objects.link(rig)
    bpy.context.window.scene = scratch
    baked = []
    for clip in CLIPS:
        action = by_name.get(clip)
        if action:
            baked.append(retarget(src, rig, action, scratch))
    scratch.collection.objects.unlink(rig)
    for obj in list(scratch.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    bpy.data.scenes.remove(scratch)
    for action in ual_actions:
        if action.users == 0:
            bpy.data.actions.remove(action)
    bpy.context.window.scene = scene

    rig.animation_data_create()
    for track in list(rig.animation_data.nla_tracks):
        rig.animation_data.nla_tracks.remove(track)
    for action in baked:
        name = action.name.replace("_ceo", "")
        action.name = name
        track = rig.animation_data.nla_tracks.new()
        track.name = name
        track.strips.new(name, int(action.frame_range[0]), action)
        track.mute = True
    for pb in rig.pose.bones:
        pb.matrix_basis.identity()
    game_ready_textures(meshes)
    return scene, rig, meshes, [a.name for a in baked]


def export_glb(scene, rig, meshes):
    for obj in scene.objects:
        obj.select_set(obj is rig or obj in meshes)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.export_scene.gltf(
        filepath=GLB_OUT, export_format="GLB", use_selection=True, use_active_scene=True, export_apply=False,
        export_animations=True, export_animation_mode="NLA_TRACKS", export_force_sampling=True,
        export_skins=True, export_morph=False, export_image_format="WEBP", export_image_quality=85, export_yup=True)
    return os.path.getsize(GLB_OUT)


scene, rig, meshes, clips = build()
result = {"clips": clips, "meshes": [m.name for m in meshes], "glb_bytes": export_glb(scene, rig, meshes)}
